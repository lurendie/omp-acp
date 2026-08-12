//! OMP Agent — Oh My Pi (omp) integration for Zed.
//!
//! Two integration surfaces:
//! 1. **External Agent (ACP)** — the companion `scripts/install.ps1` registers
//!    `omp acp` under `agent_servers.omp` in Zed settings, giving a full
//!    Agent Panel thread driven by omp (model auth, tools, sessions owned by omp).
//! 2. **MCP context server** — this extension exposes the `omp` context server:
//!    a Node bridge (`bridge/server.mjs`) that hosts a persistent
//!    `omp --mode rpc` child per project and exposes omp as MCP tools
//!    (`omp_run`, `omp_continue`, `omp_status`, ...) callable by the built-in
//!    Zed Agent for delegation.
//!
//! The WASM sandbox cannot resolve `$HOME` or spawn interactive processes, so
//! the context server command is a tiny `node -e` loader that resolves the
//! bridge script (default `~/.omp/zed/bridge.mjs`, overridable via
//! `context_servers.omp.settings.bridgePath`) and forwards the user settings
//! JSON through the `OMP_ZED_CFG` environment variable.

use zed_extension_api as zed;

/// Must match `[context_servers.omp]` in extension.toml.
const CONTEXT_SERVER_ID: &str = "omp";

/// Loader that runs the bridge with Node. The bridge path and settings come
/// from the environment because the WASM extension has no home/FS access.
const BRIDGE_LOADER: &str = r#"const fs=require('fs'),path=require('path'),os=require('os');
let bridge=process.env.OMP_ZED_BRIDGE||path.join(os.homedir(),'.omp','zed','bridge.cjs');
if(!fs.existsSync(bridge)){console.error('[omp-mcp] bridge not found: '+bridge);process.exit(1);}
const cfg=process.env.OMP_ZED_CFG;require(bridge)(cfg?JSON.parse(cfg):{});"#;

/// JSON Schema shown in Zed's MCP server settings UI for
/// `context_servers.omp.settings`.
fn settings_schema() -> String {
    r#"{
  "type": "object",
  "properties": {
    "ompPath": { "type": "string", "description": "Path to the omp executable (default: omp on PATH)" },
    "model": { "type": "string", "description": "Model for delegated omp runs (default: omp's own default)" },
    "autoConfirm": { "type": "boolean", "description": "Auto-confirm omp ask/approval dialogs. Off by default: confirm requests are answered with 'no' and logged.", "default": false },
    "timeoutMs": { "type": "number", "description": "Default timeout for omp_run / omp_continue (ms)", "default": 600000 },
    "sessionDir": { "type": "string", "description": "omp session directory for omp_continue / omp_sessions (default: ~/.omp/agent/sessions)" },
    "bridgePath": { "type": "string", "description": "Path to bridge/server.cjs (default: ~/.omp/zed/bridge.cjs)" },
    "extraArgs": { "type": "array", "items": { "type": "string" }, "description": "Extra CLI args appended to `omp --mode rpc` (e.g. --profile)" }
  }
}"#
    .into()
}

pub struct OmpExtension;

impl zed::Extension for OmpExtension {
    fn new() -> Self {
        Self
    }

    fn context_server_configuration(
        &mut self,
        _context_server_id: &zed::ContextServerId,
        _project: &zed::Project,
    ) -> Result<Option<zed::ContextServerConfiguration>, String> {
        Ok(Some(zed::ContextServerConfiguration {
            installation_instructions: "Run `scripts/install.ps1` from the omp-acp repository, or copy `bridge/server.mjs` to `~/.omp/zed/bridge.mjs` and configure `context_servers.omp.settings` in Zed settings.".into(),
            settings_schema: settings_schema(),
            default_settings: "{}".into(),
        }))
    }

    fn context_server_command(
        &mut self,
        context_server_id: &zed::ContextServerId,
        project: &zed::Project,
    ) -> Result<zed::Command, String> {
        if context_server_id.as_ref() != CONTEXT_SERVER_ID {
            return Err(format!("Unknown context server: {context_server_id}"));
        }

        let settings =
            zed::settings::ContextServerSettings::for_project(CONTEXT_SERVER_ID, project)?;

        let mut env: Vec<(String, String)> = Vec::new();
        if let Some(json) = settings.settings {
            env.push(("OMP_ZED_CFG".to_string(), json.to_string()));
        }

        let mut cmd = zed::Command {
            command: zed::node_binary_path()?,
            args: vec!["-e".to_string(), BRIDGE_LOADER.to_string()],
            env,
        };

        // Honor user overrides from `context_servers.omp.command`.
        if let Some(overrides) = settings.command {
            if let Some(path) = overrides.path {
                cmd.command = path;
            }
            if let Some(args) = overrides.arguments {
                cmd.args = args;
            }
            if let Some(extra_env) = overrides.env {
                cmd.env.extend(extra_env);
            }
        }

        Ok(cmd)
    }

    fn run_slash_command(
        &self,
        command: zed::SlashCommand,
        _args: Vec<String>,
        _worktree: Option<&zed::Worktree>,
    ) -> Result<zed::SlashCommandOutput, String> {
        if command.name != "omp" {
            return Err(format!("Unknown slash command: {}", command.name));
        }

        // Best-effort one-shot probe; omp must be on PATH for this to work.
        let output = zed::process::Command::new("omp").arg("--version").output()?;
        let version = String::from_utf8_lossy(&output.stdout)
            .trim()
            .to_string();
        if version.is_empty() {
            return Err(String::from_utf8_lossy(&output.stderr).to_string());
        }

        Ok(zed::SlashCommandOutput {
            text: format!("OMP {version}"),
            sections: Vec::new(),
        })
    }
}

zed::register_extension!(OmpExtension);
