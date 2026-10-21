//! Updates of the app itself. It looks for a newer desktop release at start and then every few hours,
//! downloads it in the background, and says so (a notification, and "Restart to update" in the menus).
//! It installs only when the person chooses to, never in the middle of a call. Updates are signed with the
//! project's updater key (tauri.conf.json holds its public half): an update that does not verify is refused.

use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Manager, Url};
use tauri_plugin_updater::{Update, UpdaterExt};

/// A downloaded update, waiting for the person to restart.
pub struct Ready {
    pub update: Update,
    pub bytes: Vec<u8>,
}

#[derive(Default)]
pub struct Updates {
    pub ready: Mutex<Option<Ready>>,
}

impl Updates {
    /// The version waiting to be installed, for the menus.
    pub fn ready_version(&self) -> Option<String> {
        self.ready.lock().unwrap().as_ref().map(|r| r.update.version.clone())
    }
}

const FIRST_CHECK: Duration = Duration::from_secs(30);
const EVERY: Duration = Duration::from_secs(6 * 3600);

/// Checks now and then in the background. `endpoint` replaces the release feed (tests, a mirror).
pub fn watch(app: AppHandle, endpoint: Option<Url>, on_ready: fn(&AppHandle, &str)) {
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK);
        loop {
            if let Err(e) = tauri::async_runtime::block_on(check(&app, endpoint.clone(), on_ready)) {
                eprintln!("update check failed: {e}");
            }
            std::thread::sleep(EVERY);
        }
    });
}

async fn check(app: &AppHandle, endpoint: Option<Url>, on_ready: fn(&AppHandle, &str)) -> Result<(), String> {
    let updates = app.state::<Updates>();
    if updates.ready.lock().unwrap().is_some() {
        return Ok(()); // one is already waiting for a restart
    }
    let mut builder = app.updater_builder();
    if let Some(url) = endpoint {
        builder = builder.endpoints(vec![url]).map_err(|e| e.to_string())?;
    }
    let updater = builder.build().map_err(|e| e.to_string())?;
    let Some(update) = updater.check().await.map_err(|e| e.to_string())? else { return Ok(()) };
    // the download is verified against the updater key before it is kept
    let bytes = update.download(|_, _| {}, || {}).await.map_err(|e| e.to_string())?;
    let version = update.version.clone();
    *updates.ready.lock().unwrap() = Some(Ready { update, bytes });
    eprintln!("update {version} downloaded");
    on_ready(app, &version);
    Ok(())
}

/// Installs the waiting update and starts the new version. On Windows the installer closes the app.
pub fn install_and_restart(app: &AppHandle) {
    let Some(ready) = app.state::<Updates>().ready.lock().unwrap().take() else { return };
    match ready.update.install(ready.bytes) {
        Ok(()) => app.restart(),
        Err(e) => eprintln!("update install failed: {e}"),
    }
}
