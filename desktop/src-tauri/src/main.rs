use std::env;
use std::process::Command;
use std::path::Path;
use walkdir::WalkDir;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
struct ToolEvent {
    #[serde(rename = "type")]
    event_type: String,
    name: String,
    args: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
struct MessageEvent {
    #[serde(rename = "type")]
    event_type: String,
    content: String,
}

fn repo_root() -> std::path::PathBuf {
    // Tauri runs with cwd = the launch directory. The driver lives at
    // <repo>/desktop/scripts/ox-acp-driver.mjs, so walk up until
    // src/models.js exists.
    let mut dir = env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf());
    loop {
        if dir.join("src").join("models.js").exists() {
            return dir;
        }
        match dir.parent() {
            Some(p) => dir = p.to_path_buf(),
            None => return env::current_dir().unwrap_or_else(|_| Path::new(".").to_path_buf()),
        }
    }
}

fn run_node_snippet(script: &str, timeout_secs: u64) -> Result<String, String> {
    let root = repo_root();
    let mut child = Command::new("node")
        .arg("--input-type=module")
        .arg("-e")
        .arg(script)
        .current_dir(&root)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn node: {e}"))?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    loop {
        match child.try_wait().map_err(|e| format!("wait failed: {e}"))? {
            Some(status) => {
                let out = child
                    .wait_with_output()
                    .map_err(|e| format!("read output failed: {e}"))?;
                let stdout = String::from_utf8_lossy(&out.stdout).to_string();
                let stderr = String::from_utf8_lossy(&out.stderr).to_string();
                if !status.success() {
                    return Err(format!("ox models bridge failed: {}", stderr.trim()));
                }
                return Ok(stdout);
            }
            None => {
                if std::time::Instant::now() >= deadline {
                    let _ = child.kill();
                    return Err(format!("ox models bridge timed out after {timeout_secs}s"));
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
        }
    }
}

#[tauri::command]
fn ox_models() -> Result<String, String> {
    run_node_snippet(
        "import('./src/models.js').then(async (m) => { const r = m.listModels(); const providers = m.listProviders(); process.stdout.write(JSON.stringify({models: r.models, withheld: r.withheld, providers})); })",
        10,
    )
}

#[tauri::command]
fn ox_local_scan() -> Result<String, String> {
    run_node_snippet(
        "import('./src/models.js').then(async (m) => { const local = await m.listLocalEndpoints({ deadlineMs: 2500 }); process.stdout.write(JSON.stringify(local)); })",
        15,
    )
}

#[tauri::command]
fn ox_default_bot() -> Result<String, String> {
    run_node_snippet(
        "import('./src/config.js').then(async (c) => { const cfg = c.loadConfig(); const b = await import('./src/bots.js'); process.stdout.write(JSON.stringify({ defaultBot: b.defaultBotSpec(cfg), cwd: cfg.cwd })); })",
        10,
    )
}

#[tauri::command]
fn ox_run(prompt: String, target: Option<String>, extra_env_json: Option<String>) -> Result<String, String> {
    let cwd = env::current_dir()
        .map_err(|e| format!("Failed to resolve working directory: {e}"))?;
    let driver = cwd.join("desktop").join("scripts").join("ox-acp-driver.mjs");

    if !driver.exists() {
        return Err(format!("ACP driver not found at {}", driver.display()));
    }

    let mut cmd = Command::new("node");
    cmd.arg(&driver)
        .arg("--cwd")
        .arg(&cwd)
        .arg("--prompt")
        .arg(&prompt);

    if let Some(t) = target {
        if !t.trim().is_empty() {
            cmd.arg("--target").arg(t);
        }
    }

    // Per-session API keys from the model picker as JSON {KEY: value}.
    // Allowlist only — anything else is dropped, never forwarded.
    const ALLOWED_KEYS: &[&str] = &[
        "XAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY",
        "GEMINI_API_KEY", "GROQ_API_KEY", "OPENROUTER_API_KEY",
        "DEEPSEEK_API_KEY", "BACKBOARD_API_KEY",
        "OX_API_KEY", "OX_BASE_URL", "OX_MODEL",
    ];
    if let Some(json) = extra_env_json {
        if let Ok(map) = serde_json::from_str::<std::collections::HashMap<String, String>>(&json) {
            for (k, v) in map {
                if ALLOWED_KEYS.contains(&k.as_str()) && !v.trim().is_empty() {
                    cmd.arg("--set-env").arg(format!("{k}={v}"));
                }
            }
        }
    }
    let cwd = env::current_dir()
        .map_err(|e| format!("Failed to resolve working directory: {e}"))?;
    let driver = cwd.join("desktop").join("scripts").join("ox-acp-driver.mjs");

    if !driver.exists() {
        return Err(format!("ACP driver not found at {}", driver.display()));
    }

    let mut cmd = Command::new("node");
    cmd.arg(driver)
        .arg("--cwd")
        .arg(&cwd)
        .arg("--prompt")
        .arg(&prompt);

    let output = cmd.output()
        .map_err(|e| format!("Failed to spawn ox ACP driver: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("ox ACP driver exited with error: {stderr}"));
    }

    Ok(stdout)
}

#[tauri::command]
fn ox_list_files(path: String) -> Result<Vec<String>, String> {
    let root = Path::new(&path);
    let mut files = Vec::new();

    if !root.exists() {
        return Ok(files);
    }

    for entry in WalkDir::new(root).max_depth(3).into_iter().filter_map(|e| e.ok()) {
        let rel = entry.path().strip_prefix(root).unwrap_or(entry.path());
        let rel_str = rel.to_string_lossy().to_string();
        if !rel_str.is_empty() && !rel_str.starts_with('.') {
            files.push(rel_str);
        }
    }

    files.sort();
    Ok(files)
}

#[tauri::command]
fn ox_read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    if !p.exists() {
        return Err(format!("File not found: {}", path));
    }
    if !p.is_file() {
        return Err(format!("Not a file: {}", path));
    }
    std::fs::read_to_string(p).map_err(|e| format!("Failed to read file {}: {}", path, e))
}

#[tauri::command]
fn ox_write_file(path: String, content: String) -> Result<(), String> {
    let p = Path::new(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("Failed to create parent dirs: {}", e))?;
    }
    std::fs::write(p, content).map_err(|e| format!("Failed to write file {}: {}", path, e))
}

#[tauri::command]
fn ox_load_plan(id: String) -> Result<Option<String>, String> {
    let path = Path::new(".agent/plans").join(format!("{id}.json"));
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[tauri::command]
fn ox_get_procedural() -> Result<Option<String>, String> {
    let path = Path::new(".agent/procedural.md");
    if !path.exists() {
        return Ok(None);
    }
    std::fs::read_to_string(&path).map(Some).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            ox_run,
            ox_models,
            ox_local_scan,
            ox_default_bot,
            ox_list_files,
            ox_read_file,
            ox_write_file,
            ox_load_plan,
            ox_get_procedural
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

fn main() {
    run();
}
