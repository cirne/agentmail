//! Dev helper: parse a raw `.eml` file and print attachment filenames (uses `parse_raw_message`).
//! Usage: `cargo run --example parse_eml -- /path/to/file.eml`

use std::env;
use std::fs;
use std::process;

fn main() {
    let path = env::args().nth(1).unwrap_or_else(|| {
        eprintln!("usage: cargo run --example parse_eml -- <path.eml>");
        process::exit(2);
    });
    let raw = fs::read(&path).unwrap_or_else(|e| {
        eprintln!("read {}: {e}", path);
        process::exit(1);
    });
    let p = zmail::parse_raw_message(&raw);
    println!("message_id: {}", p.message_id);
    println!("attachments: {}", p.attachments.len());
    for (i, a) in p.attachments.iter().enumerate() {
        println!(
            "  {}. {} | {} | {} bytes",
            i + 1,
            a.filename,
            a.mime_type,
            a.size
        );
    }
}
