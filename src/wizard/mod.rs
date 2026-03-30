//! Interactive `zmail wizard` — printed banner + inquire prompts (Node `wizard.ts` parity).

use std::fmt;
use std::io::{self, IsTerminal, Write};
use std::path::PathBuf;

use indicatif::{ProgressBar, ProgressStyle};
use inquire::validator::Validation;
use inquire::Confirm;
use inquire::{Password, Select, Text as InquireText};

use crate::config::{load_config, LoadConfigOptions};
use crate::send::verify_smtp_credentials;
use crate::setup::{
    clean_zmail_home, derive_imap_settings, load_existing_env_secrets, load_existing_wizard_config,
    mask_secret, validate_imap_credentials, validate_openai_key, write_zmail_config_and_env,
    WriteZmailParams,
};
use crate::sync::spawn_sync_background_detached;

const NON_TTY_MSG: &str = "Wizard requires an interactive terminal. Use 'zmail setup' instead.";

/// Options for `zmail wizard` (Node `runWizard` flags).
#[derive(Debug, Clone)]
pub struct WizardOptions {
    pub home: PathBuf,
    pub no_validate: bool,
    pub clean: bool,
    pub yes: bool,
}

#[derive(Clone)]
struct SyncChoice {
    value: &'static str,
    name: &'static str,
    desc: &'static str,
}

impl fmt::Display for SyncChoice {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} — {}", self.name, self.desc)
    }
}

const SYNC_CHOICES: &[SyncChoice] = &[
    SyncChoice {
        value: "7d",
        name: "7 days",
        desc: "Quick start, recent email only",
    },
    SyncChoice {
        value: "5w",
        name: "5 weeks",
        desc: "",
    },
    SyncChoice {
        value: "3m",
        name: "3 months",
        desc: "",
    },
    SyncChoice {
        value: "1y",
        name: "1 year (recommended)",
        desc: "Good balance of history and sync time",
    },
    SyncChoice {
        value: "2y",
        name: "2 years",
        desc: "",
    },
];

/// Print a multi-line ASCII banner to the terminal (non-blocking, like other CLI tools).
fn print_welcome_banner() {
    let color = io::stdout().is_terminal() && std::env::var_os("NO_COLOR").is_none();
    let (bold_cyan, dim, reset) = if color {
        ("\x1b[1;36m", "\x1b[2m", "\x1b[0m")
    } else {
        ("", "", "")
    };
    let logo = concat!(
        "███████╗███╗   ███╗ █████╗ ██╗██╗     \n",
        "╚══███╔╝████╗ ████║██╔══██╗██║██║     \n",
        "  ███╔╝ ██╔████╔██║███████║██║██║     \n",
        " ███╔╝  ██║╚██╔╝██║██╔══██║██║██║     \n",
        "███████╗██║ ╚═╝ ██║██║  ██║██║███████╗\n",
        "╚══════╝╚═╝     ╚═╝╚═╝  ╚═╝╚═╝╚══════╝",
    );
    println!();
    println!("{bold_cyan}{logo}{reset}");
    println!("{dim}  agent-first email{reset}");
    println!("{dim}  Let's get you connected{reset}");
    println!();
    let _ = io::stdout().flush();
}

fn spinner(msg: &'static str) -> ProgressBar {
    let pb = ProgressBar::new_spinner();
    pb.set_style(
        ProgressStyle::default_spinner()
            .template("{spinner:.cyan} {msg}")
            .unwrap(),
    );
    pb.set_message(msg);
    pb.enable_steady_tick(std::time::Duration::from_millis(80));
    pb
}

/// Run the interactive wizard (TTY required).
pub fn run_wizard(opts: WizardOptions) -> Result<(), Box<dyn std::error::Error>> {
    if !io::stdin().is_terminal() {
        eprintln!("{NON_TTY_MSG}");
        std::process::exit(1);
    }

    let home = &opts.home;
    std::fs::create_dir_all(home)?;

    if opts.clean {
        let has = home.join("config.json").is_file()
            || home.join(".env").is_file()
            || home.join("data").exists();
        if has {
            if !opts.yes {
                let proceed =
                    Confirm::new("This will delete all existing config and data. Continue?")
                        .with_default(false)
                        .prompt()?;
                if !proceed {
                    println!("Cancelled.");
                    std::process::exit(0);
                }
            }
            clean_zmail_home(home)?;
            println!("Done.\n");
        }
    }

    let existing_cfg = load_existing_wizard_config(home);
    let existing_env = load_existing_env_secrets(home);
    let is_first_run = existing_cfg.email.is_none() && existing_env.password.is_none();

    print_welcome_banner();

    if is_first_run {
        println!("\nzmail wizard — let's get you connected.\n");
    } else {
        println!("\nzmail wizard — updating existing config.\n");
    }

    let email_default = existing_cfg.email.clone().unwrap_or_default();
    let email = InquireText::new("Email address")
        .with_default(&email_default)
        .with_validator(|s: &str| {
            if s.trim().is_empty() {
                Ok(Validation::Invalid("Email address is required".into()))
            } else {
                Ok(Validation::Valid)
            }
        })
        .prompt()?;
    let email = email.trim().to_string();
    if email.is_empty() {
        return Err("Email address is required.".into());
    }

    let derived = derive_imap_settings(&email);
    let host_default = existing_cfg
        .imap_host
        .clone()
        .or_else(|| derived.as_ref().map(|d| d.host.clone()))
        .unwrap_or_else(|| "imap.gmail.com".into());
    let port_default = existing_cfg
        .imap_port
        .or_else(|| derived.as_ref().map(|d| d.port))
        .unwrap_or(993);

    if let Some(ref d) = derived {
        let label = if d.host == "imap.gmail.com" {
            "Gmail"
        } else {
            "Provider"
        };
        println!("  → {label} detected ({}:{})\n", d.host, d.port);
    }

    let (imap_host, imap_port) = if derived.is_some() {
        (host_default, port_default)
    } else {
        let host = InquireText::new("IMAP host")
            .with_default(&host_default)
            .prompt()?;
        let port_s = InquireText::new("IMAP port")
            .with_default(&port_default.to_string())
            .prompt()?;
        let port: u16 = port_s.trim().parse().unwrap_or(port_default);
        (host.trim().to_string(), port)
    };

    let password_value: String = if let Some(ref existing_pw) = existing_env.password {
        let pw_msg = format!("Use existing IMAP password ({})?", mask_secret(existing_pw));
        let use_existing = Confirm::new(&pw_msg).with_default(true).prompt()?;
        if use_existing {
            existing_pw.clone()
        } else {
            Password::new("IMAP app password")
                .without_confirmation()
                .prompt()?
        }
    } else {
        println!("Gmail requires an app password (not your regular password).");
        println!("An app password is a 16-character code that lets IMAP clients like zmail access your mail without your main password.");
        println!("Enable 2-Step Verification first if you don't have it: https://myaccount.google.com/signinoptions/two-step-verification");
        println!("Then create an app password: https://myaccount.google.com/apppasswords\n");
        Password::new("IMAP app password")
            .without_confirmation()
            .prompt()?
    };

    if password_value.is_empty() {
        return Err("IMAP password is required.".into());
    }

    if !opts.no_validate {
        let pb = spinner("Connecting to IMAP…");
        let r = validate_imap_credentials(&imap_host, imap_port, &email, &password_value);
        pb.finish_and_clear();
        r.inspect_err(|_| {
            eprintln!("  Could not connect. Check your credentials and try again.");
        })?;
        println!("  Connected to {imap_host} as {email}");
    }

    if !opts.no_validate {
        let pb = spinner("Verifying SMTP…");
        let r = verify_smtp_credentials(&imap_host, &email, &password_value);
        pb.finish_and_clear();
        r.map_err(|_| {
            eprintln!("  Could not verify SMTP. Check your credentials and try again.");
            "SMTP verification failed".to_string()
        })?;
        println!("  SMTP OK");
    }

    let api_key: String = if let Some(ref existing_key) = existing_env.api_key {
        let key_msg = format!(
            "Use existing OpenAI API key ({})?",
            mask_secret(existing_key)
        );
        let use_existing = Confirm::new(&key_msg).with_default(true).prompt()?;
        if use_existing {
            existing_key.clone()
        } else {
            println!("Get one at https://platform.openai.com/api-keys");
            Password::new("OpenAI API key")
                .without_confirmation()
                .prompt()?
        }
    } else {
        println!("Get one at https://platform.openai.com/api-keys");
        Password::new("OpenAI API key")
            .without_confirmation()
            .prompt()?
    };

    if api_key.trim().is_empty() {
        return Err("OpenAI API key is required.".into());
    }

    if !opts.no_validate {
        let pb = spinner("Validating OpenAI API key…");
        let r = validate_openai_key(api_key.trim());
        pb.finish_and_clear();
        r.map_err(|_| {
            eprintln!("  Invalid API key. Check your key and try again.");
            "OpenAI validation failed".to_string()
        })?;
        println!("  API key valid");
    }

    let default_since = existing_cfg.default_since.as_deref().unwrap_or("1y");
    let valid: &[&str] = &["7d", "5w", "3m", "1y", "2y"];
    let default_idx = if valid.contains(&default_since) {
        SYNC_CHOICES
            .iter()
            .position(|c| c.value == default_since)
            .unwrap_or(3)
    } else {
        3
    };

    let since = Select::new("Sync default duration", SYNC_CHOICES.to_vec())
        .with_starting_cursor(default_idx)
        .prompt()?;

    write_zmail_config_and_env(&WriteZmailParams {
        home,
        email: &email,
        password: &password_value,
        openai_key: Some(api_key.trim()),
        imap_host: &imap_host,
        imap_port,
        default_since: since.value,
    })?;

    println!("\nConfig saved to {}/", home.display());

    let should_sync = Confirm::new("Start syncing email now?")
        .with_default(true)
        .prompt()?;

    if should_sync {
        println!("\nStarting sync in background (--since {})...", since.value);
        let cfg = load_config(LoadConfigOptions {
            home: Some(home.clone()),
            env: None,
        });
        spawn_sync_background_detached(home, &cfg, Some(since.value))?;
        println!("\nTry a search while it syncs:");
        println!("  zmail search \"purchase or invoices\"");
    } else {
        println!("Run `zmail sync --since 7d` to start initial sync, then `zmail refresh` for frequent updates.");
    }
    println!();
    Ok(())
}
