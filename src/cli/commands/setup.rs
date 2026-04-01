use std::collections::HashMap;
use std::io::Write;

use crate::cli::util::{load_cfg, zmail_home_path};
use crate::cli::CliResult;
use zmail::{
    resolve_openai_api_key, resolve_setup_email, resolve_setup_password, run_wizard,
    validate_imap_credentials, validate_openai_key, verify_smtp_credentials, write_setup,
    LoadConfigOptions, SetupArgs, WizardOptions,
};

pub(crate) fn run_setup(
    email: Option<String>,
    password: Option<String>,
    openai_key: Option<String>,
    no_validate: bool,
) -> CliResult {
    let home = zmail_home_path();
    let env_map: HashMap<String, String> = std::env::vars().collect();
    let args = SetupArgs {
        email,
        password,
        openai_key: openai_key.clone(),
        no_validate,
    };

    let Some(email) = resolve_setup_email(&args, &env_map) else {
        return Err("Provide --email or set ZMAIL_EMAIL".into());
    };
    let Some(password) = resolve_setup_password(&args, &env_map) else {
        return Err("Provide --password or set ZMAIL_IMAP_PASSWORD".into());
    };

    write_setup(&home, &email, &password, openai_key.as_deref())?;
    if !no_validate {
        let cfg = load_cfg();

        print!("Validating IMAP... ");
        std::io::stdout().flush().ok();
        if validate_imap_credentials(
            &cfg.imap_host,
            cfg.imap_port,
            &cfg.imap_user,
            &cfg.imap_password,
        )
        .is_err()
        {
            println!("Failed");
            eprintln!("Could not connect to IMAP. Check your credentials.");
            std::process::exit(1);
        }
        println!("OK");

        print!("Validating SMTP... ");
        std::io::stdout().flush().ok();
        if verify_smtp_credentials(&cfg.imap_host, &cfg.imap_user, &cfg.imap_password).is_err() {
            println!("Failed");
            eprintln!("Could not verify SMTP. Check your credentials and network.");
            std::process::exit(1);
        }
        println!("OK");

        let Some(api_key) = resolve_openai_api_key(&LoadConfigOptions {
            home: Some(home.clone()),
            env: None,
        }) else {
            println!("Failed");
            eprintln!("OpenAI API key missing after setup.");
            std::process::exit(1);
        };

        print!("Validating OpenAI API key... ");
        std::io::stdout().flush().ok();
        if validate_openai_key(&api_key).is_err() {
            println!("Failed");
            eprintln!("Invalid API key.");
            std::process::exit(1);
        }
        println!("OK");
    }

    println!("Wrote config under {}", home.display());
    Ok(())
}

pub(crate) fn run_wizard_command(no_validate: bool, clean: bool, yes: bool) -> CliResult {
    run_wizard(WizardOptions {
        home: zmail_home_path(),
        no_validate,
        clean,
        yes,
    })?;
    Ok(())
}
