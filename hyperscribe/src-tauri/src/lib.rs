use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
struct Settings {
    api_key: String,
    project_id: Option<String>,
}

#[derive(Serialize, Clone)]
struct Utterance {
    speaker: i64,
    transcript: String,
}

#[derive(Serialize, Clone)]
struct Balance {
    amount: f64,
    units: String,
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("Konfigurationsordner nicht gefunden: {e}"))?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Konfigurationsordner konnte nicht erstellt werden: {e}"))?;
    Ok(dir.join("settings.json"))
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Option<Settings>, String> {
    let path = settings_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let data = std::fs::read_to_string(&path)
        .map_err(|e| format!("Einstellungen konnten nicht gelesen werden: {e}"))?;
    let settings: Settings = serde_json::from_str(&data)
        .map_err(|e| format!("Einstellungen sind beschädigt: {e}"))?;
    Ok(Some(settings))
}

#[tauri::command]
fn save_settings(app: AppHandle, api_key: String, project_id: Option<String>) -> Result<(), String> {
    let path = settings_path(&app)?;
    let project_id = project_id.filter(|s| !s.trim().is_empty());
    let settings = Settings { api_key, project_id };
    let data = serde_json::to_string_pretty(&settings)
        .map_err(|e| format!("Einstellungen konnten nicht serialisiert werden: {e}"))?;
    std::fs::write(&path, data)
        .map_err(|e| format!("Einstellungen konnten nicht gespeichert werden: {e}"))
}

fn resolve_api_key(app: &AppHandle) -> Result<String, String> {
    if let Ok(Some(settings)) = load_settings(app.clone()) {
        if !settings.api_key.trim().is_empty() {
            return Ok(settings.api_key);
        }
    }
    std::env::var("DEEPGRAM_API_KEY")
        .map_err(|_| "Kein Deepgram-API-Key hinterlegt. Bitte in den Einstellungen eintragen.".to_string())
}

fn resolve_project_id_setting(app: &AppHandle) -> Option<String> {
    load_settings(app.clone()).ok().flatten().and_then(|s| s.project_id)
}

fn guess_mime(path: &str) -> &'static str {
    match Path::new(path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase()
        .as_str()
    {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "opus" => "audio/opus",
        "flac" => "audio/flac",
        "webm" => "audio/webm",
        _ => "application/octet-stream",
    }
}

#[tauri::command]
async fn transcribe_audio(
    app: AppHandle,
    path: String,
    language: String,
) -> Result<Vec<Utterance>, String> {
    let api_key = resolve_api_key(&app)?;

    app.emit("transcription-progress", "preparing").ok();
    let bytes = tokio::fs::read(&path)
        .await
        .map_err(|e| format!("Datei konnte nicht gelesen werden: {e}"))?;
    let content_type = guess_mime(&path);

    let mut url = "https://api.deepgram.com/v1/listen?model=nova-3&diarize_model=latest&utterances=true&smart_format=true".to_string();
    match language.as_str() {
        "de" => url.push_str("&language=de"),
        "en" => url.push_str("&language=en"),
        _ => url.push_str("&detect_language=true"),
    }

    app.emit("transcription-progress", "transcribing").ok();
    let client = reqwest::Client::new();
    let response = client
        .post(&url)
        .header("Authorization", format!("Token {api_key}"))
        .header("Content-Type", content_type)
        .body(bytes)
        .send()
        .await
        .map_err(|e| format!("Anfrage an Deepgram fehlgeschlagen: {e}"))?;

    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Deepgram-Fehler ({status}): {body}"));
    }

    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Antwort konnte nicht gelesen werden: {e}"))?;

    let raw_utterances = json["results"]["utterances"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|u| Utterance {
            speaker: u["speaker"].as_i64().unwrap_or(0),
            transcript: u["transcript"].as_str().unwrap_or("").to_string(),
        });

    // Deepgram splits same-speaker speech into multiple utterances on short
    // pauses; merge consecutive ones from the same speaker into one block.
    let mut utterances: Vec<Utterance> = Vec::new();
    for u in raw_utterances {
        match utterances.last_mut() {
            Some(last) if last.speaker == u.speaker => {
                last.transcript.push(' ');
                last.transcript.push_str(&u.transcript);
            }
            _ => utterances.push(u),
        }
    }

    if utterances.is_empty() {
        return Err("Keine Transkription erhalten (Audiodatei ohne Sprache?).".to_string());
    }

    app.emit("transcription-progress", "done").ok();
    Ok(utterances)
}

#[tauri::command]
fn save_transcript(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| format!("Speichern fehlgeschlagen: {e}"))
}

async fn fetch_project_id(
    app: &AppHandle,
    client: &reqwest::Client,
    api_key: &str,
) -> Result<String, String> {
    if let Some(id) = resolve_project_id_setting(app) {
        return Ok(id);
    }
    if let Ok(id) = std::env::var("DEEPGRAM_PROJECT_ID") {
        if !id.is_empty() {
            return Ok(id);
        }
    }
    let response = client
        .get("https://api.deepgram.com/v1/projects")
        .header("Authorization", format!("Token {api_key}"))
        .send()
        .await
        .map_err(|e| format!("Projekte konnten nicht geladen werden: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Projekte-Abruf fehlgeschlagen ({status}): {body}"));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Antwort konnte nicht gelesen werden: {e}"))?;
    json["projects"][0]["project_id"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Kein Deepgram-Projekt gefunden.".to_string())
}

#[tauri::command]
async fn get_balance(app: AppHandle) -> Result<Balance, String> {
    let api_key = resolve_api_key(&app)?;
    let client = reqwest::Client::new();
    let project_id = fetch_project_id(&app, &client, &api_key).await?;

    let response = client
        .get(format!(
            "https://api.deepgram.com/v1/projects/{project_id}/balances"
        ))
        .header("Authorization", format!("Token {api_key}"))
        .send()
        .await
        .map_err(|e| format!("Guthaben konnte nicht geladen werden: {e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        return Err(format!("Guthaben-Abruf fehlgeschlagen ({status}): {body}"));
    }
    let json: serde_json::Value = response
        .json()
        .await
        .map_err(|e| format!("Antwort konnte nicht gelesen werden: {e}"))?;
    let balances = json["balances"].as_array().cloned().unwrap_or_default();
    let amount: f64 = balances.iter().filter_map(|b| b["amount"].as_f64()).sum();
    let units = balances
        .first()
        .and_then(|b| b["units"].as_str())
        .unwrap_or("USD")
        .to_string();
    Ok(Balance { amount, units })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    dotenvy::dotenv().ok();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            transcribe_audio,
            save_transcript,
            get_balance,
            load_settings,
            save_settings
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
