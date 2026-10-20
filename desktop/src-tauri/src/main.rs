// Home Quarters desktop: the office's own web client in a window of its own, in the system webview.
// The shell remembers the offices you use and opens one at a time. An office is a remote page and gets
// no access to the shell: commands answer the bundled offices page alone (Tauri refuses IPC from remote
// origins unless a capability names them, and none does).
//
// Signing in never happens in this window: the office page's sign-in button opens the person's own
// browser, and the window then receives the session (server/internal/httpapi/handoff.go).
//
// It lives in the tray (the Dock on a Mac): closing the window hides it there, and the page is told so it stops every
// capture and sets the person busy (web/src/desktopWindow.ts). Quitting is in the menus.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use sha2::{Digest, Sha256};

use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::{NewWindowResponse, PageLoadEvent, PermissionKind, PermissionResponse};
use tauri::{AppHandle, Manager, Runtime, State, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};

mod office;
mod offices;

use offices::Offices;

const MAIN: &str = "main";
const TRAY: &str = "tray";

/// Set once the app is really leaving (Quit, Cmd+Q, the Dock's Quit): closing the window then lets it
/// close instead of hiding it in the tray.
static QUITTING: AtomicBool = AtomicBool::new(false);

fn quit(app: &AppHandle) {
    QUITTING.store(true, Ordering::SeqCst);
    app.exit(0);
}

struct Shell {
    dir: PathBuf,
    offices: Mutex<Offices>,
    /// the office given with --office (not saved)
    cli_office: Option<Url>,
    /// the page the window shows, kept at each page load for the permission handler
    page: Mutex<Option<Url>>,
}

impl Shell {
    /// Whether a page belongs to one of the offices this app opens.
    fn knows(&self, url: &Url) -> bool {
        self.cli_office.as_ref().is_some_and(|o| office::same_origin(o, url))
            || self.offices.lock().unwrap().list.iter().any(|o| Url::parse(&o.url).is_ok_and(|o| office::same_origin(&o, url)))
    }
}

impl Shell {
    fn save(&self) -> Result<(), String> {
        let body = serde_json::to_vec_pretty(&*self.offices.lock().unwrap()).map_err(|e| e.to_string())?;
        std::fs::create_dir_all(&self.dir).map_err(|e| e.to_string())?;
        std::fs::write(self.dir.join("offices.json"), body).map_err(|e| e.to_string())
    }
}

/// The offices page reads the list from here.
#[tauri::command]
fn list_offices(shell: State<Shell>) -> Offices {
    shell.offices.lock().unwrap().clone()
}

/// Checks an address typed on the offices page (or picked from its list), remembers it and opens it.
#[tauri::command]
fn open_office(address: String, app: AppHandle, shell: State<Shell>, window: WebviewWindow) -> Result<(), String> {
    let url = office::parse(&address)?;
    shell.offices.lock().unwrap().open(url.as_str());
    shell.save()?;
    refresh_menus(&app);
    window.navigate(url).map_err(|e| e.to_string())
}

/// Forgets an office; the page gets the list back.
#[tauri::command]
fn remove_office(url: String, app: AppHandle, shell: State<Shell>) -> Result<Offices, String> {
    shell.offices.lock().unwrap().remove(&url);
    shell.save()?;
    refresh_menus(&app);
    Ok(shell.offices.lock().unwrap().clone())
}

/// Command-line options: `--office=<url>` opens that office without saving it (a shortcut per office),
/// `--data-dir=<path>` keeps the offices and the webview's cookies and storage there instead of the
/// user's application data (separate profiles, tests).
struct Args {
    office: Option<String>,
    data_dir: Option<PathBuf>,
}

fn args() -> Args {
    let mut a = Args { office: None, data_dir: None };
    for arg in std::env::args().skip(1) {
        if let Some(v) = arg.strip_prefix("--office=") {
            a.office = Some(v.to_string());
        } else if let Some(v) = arg.strip_prefix("--data-dir=") {
            a.data_dir = Some(PathBuf::from(v));
        }
    }
    a
}

/// One entry per saved office (the open one checked), for the window menu and the tray menu.
fn office_items<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Vec<CheckMenuItem<R>>> {
    let offices = app.state::<Shell>().offices.lock().unwrap().clone();
    offices
        .list
        .iter()
        .enumerate()
        .map(|(i, o)| CheckMenuItem::with_id(app, format!("go:{i}"), offices::label(o), true, offices.current.as_deref() == Some(&o.url), None::<&str>))
        .collect()
}

/// The Office menu: the saved offices, then adding and managing them, and reloading the page.
fn office_menu<R: Runtime>(app: &AppHandle<R>, with_quit: bool) -> tauri::Result<Submenu<R>> {
    let list = office_items(app)?;
    let add = MenuItem::with_id(app, "add", "Add office...", true, None::<&str>)?;
    let manage = MenuItem::with_id(app, "manage", "Manage offices...", true, None::<&str>)?;
    let reload = MenuItem::with_id(app, "reload", "Reload", true, Some("CmdOrCtrl+R"))?;
    let quit = MenuItem::with_id(app, "quit", "Quit", true, Some("CmdOrCtrl+Q"))?;
    let sep = [PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?];
    let mut items: Vec<&dyn IsMenuItem<R>> = list.iter().map(|i| i as &dyn IsMenuItem<R>).collect();
    if !items.is_empty() {
        items.push(&sep[0]);
    }
    items.extend([&add as &dyn IsMenuItem<R>, &manage, &reload]);
    if with_quit {
        items.extend([&sep[1] as &dyn IsMenuItem<R>, &quit]);
    }
    Submenu::with_items(app, "Office", true, &items)
}

/// Windows and Linux: one Office menu in the window, Quit at its end.
#[cfg(not(target_os = "macos"))]
fn window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    Menu::with_items(app, &[&office_menu(app, true)?])
}

/// macOS: the menus every Mac app has. The app menu holds Quit (Cmd+Q), and the Edit menu is what makes
/// Cmd+C, Cmd+V and Cmd+A work in the page (a webview gets them from the menu bar).
#[cfg(target_os = "macos")]
fn window_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let sep = || PredefinedMenuItem::separator(app);
    let app_menu = Submenu::with_items(
        app,
        "Home Quarters",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("About Home Quarters"), None)?,
            &sep()?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &sep()?,
            &MenuItem::with_id(app, "quit", "Quit Home Quarters", true, Some("Cmd+Q"))?,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "Edit",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &sep()?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "Window",
        true,
        &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::fullscreen(app, None)?, &sep()?, &PredefinedMenuItem::close_window(app, None)?],
    )?;
    Menu::with_items(app, &[&app_menu, &edit, &office_menu(app, false)?, &window])
}

fn tray_menu<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
    let list = office_items(app)?;
    let open = MenuItem::with_id(app, "show", "Open Home Quarters", true, None::<&str>)?;
    let manage = MenuItem::with_id(app, "manage", "Manage offices...", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Home Quarters", true, None::<&str>)?;
    let sep = [PredefinedMenuItem::separator(app)?, PredefinedMenuItem::separator(app)?];
    let mut items: Vec<&dyn IsMenuItem<R>> = vec![&open, &sep[0]];
    items.extend(list.iter().map(|i| i as &dyn IsMenuItem<R>));
    items.extend([&manage as &dyn IsMenuItem<R>, &sep[1], &quit]);
    Menu::with_items(app, &items)
}

/// Rebuilds both menus after the list or the open office changed.
fn refresh_menus(app: &AppHandle) {
    // a Mac app has one menu bar for the whole app; elsewhere the menu belongs to the window
    #[cfg(target_os = "macos")]
    if let Ok(menu) = window_menu(app) {
        let _ = app.set_menu(menu);
    }
    #[cfg(not(target_os = "macos"))]
    if let (Some(window), Ok(menu)) = (app.get_webview_window(MAIN), window_menu(app)) {
        let _ = window.set_menu(menu);
    }
    if let (Some(tray), Ok(menu)) = (app.tray_by_id(TRAY), tray_menu(app)) {
        let _ = tray.set_menu(Some(menu));
    }
}

/// Signs in through the person's browser: it gets the provider's page with only the hash of a secret
/// this window keeps, and this window waits for the session with the secret itself.
fn sign_in_in_browser(app: &AppHandle, start: &Url, provider: &str) {
    let mut bytes = [0u8; 32];
    if getrandom::fill(&mut bytes).is_err() {
        return;
    }
    let secret = URL_SAFE_NO_PAD.encode(bytes);
    let hash = URL_SAFE_NO_PAD.encode(Sha256::digest(secret.as_bytes()));
    let mut in_browser = start.clone();
    in_browser.query_pairs_mut().append_pair("handoff", &hash);
    let _ = tauri_plugin_opener::OpenerExt::opener(app).open_url(in_browser.as_str(), None::<&str>);
    if let (Some(window), Ok(wait)) = (app.get_webview_window(MAIN), start.join(&format!("/auth/{provider}/handoff/{secret}"))) {
        let _ = window.navigate(wait);
    }
}

fn open_window(app: &AppHandle, start: WebviewUrl, data: PathBuf) -> tauri::Result<WebviewWindow> {
    let opener = app.clone();
    let signer = app.clone();
    WebviewWindowBuilder::new(app, MAIN, start)
        .title("Home Quarters")
        .inner_size(1280.0, 800.0)
        .min_inner_size(640.0, 400.0)
        .menu(window_menu(app)?)
        .data_directory(data)
        .on_navigation(move |url| {
            // an office's sign-in button: the provider's page opens in the browser, never here
            if let Some(provider) = office::sign_in_provider(url) {
                if signer.state::<Shell>().knows(url) {
                    let (app, url) = (signer.clone(), url.clone());
                    tauri::async_runtime::spawn(async move { sign_in_in_browser(&app, &url, &provider) });
                    return false;
                }
            }
            // web pages only: no file://, javascript: or custom schemes in the office window
            office::navigable(url)
        })
        // The page the window shows, for the permission handler. A page load concerns the window's page
        // only, where a navigation may be a frame's (on a Mac).
        .on_page_load(|window, payload| {
            if payload.event() == PageLoadEvent::Started {
                *window.state::<Shell>().page.lock().unwrap() = Some(payload.url().clone());
            }
        })
        // Camera, microphone and screen go to the offices this app opens, and to no other page. The
        // office still asks for consent itself, and the system for its own permission.
        .on_permission_request({
            let app = app.clone();
            move |_, kind| {
                let shell = app.state::<Shell>();
                let known = shell.page.lock().unwrap().as_ref().is_some_and(|p| shell.knows(p));
                match (kind, known) {
                    (_, false) => PermissionResponse::Deny,
                    (PermissionKind::Camera | PermissionKind::Microphone | PermissionKind::DisplayCapture, true) => PermissionResponse::Allow,
                    (_, true) => PermissionResponse::Default,
                }
            }
        })
        // links meant for a new tab (about, privacy, an object's link) open in the default browser
        .on_new_window(move |url, _| {
            if office::navigable(&url) {
                let _ = tauri_plugin_opener::OpenerExt::opener(&opener).open_url(url.as_str(), None::<&str>);
            }
            NewWindowResponse::Deny
        })
        // the window says which office it shows ("Home Quarters - <office>"), and the menus learn its name
        .on_document_title_changed(|window, title| {
            let _ = window.set_title(&title);
            let app = window.app_handle();
            let shell = app.state::<Shell>();
            let learned = window.url().map(|u| shell.offices.lock().unwrap().learn_name(&u, &title)).unwrap_or(false);
            if learned {
                let _ = shell.save();
                refresh_menus(app);
            }
        })
        .build()
}

/// Tells the page whether its window is on screen (the `hq-desktop` event of web/src/desktopWindow.ts).
fn tell_page(window: &WebviewWindow, state: &str) {
    let _ = window.eval(format!("window.dispatchEvent(new CustomEvent('hq-desktop', {{ detail: '{state}' }}))"));
}

fn hide(window: &WebviewWindow) {
    tell_page(window, "hidden");
    let _ = window.hide();
}

fn show(window: &WebviewWindow) {
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    tell_page(window, "shown");
}

#[cfg(not(target_os = "macos"))]
fn tray(app: &AppHandle) -> tauri::Result<()> {
    let mut tray = TrayIconBuilder::with_id(TRAY).tooltip("Home Quarters").menu(&tray_menu(app)?).show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.on_tray_icon_event(|tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            if let Some(window) = tray.app_handle().get_webview_window(MAIN) {
                if window.is_visible().unwrap_or(false) { hide(&window) } else { show(&window) }
            }
        }
    })
    .build(app)?;
    Ok(())
}

/// The bundled offices page, on whichever origin this platform serves bundled pages from.
fn offices_page(fragment: &str) -> Option<Url> {
    let base = if cfg!(windows) { "http://tauri.localhost/" } else { "tauri://localhost/" };
    Url::parse(base).and_then(|u| u.join(&format!("index.html{fragment}"))).ok()
}

fn on_menu(app: &AppHandle, id: &str) {
    let Some(window) = app.get_webview_window(MAIN) else { return };
    match id {
        "show" => show(&window),
        "quit" => quit(app),
        "reload" => {
            let _ = window.reload();
        }
        "add" | "manage" => {
            show(&window);
            if let Some(url) = offices_page(if id == "add" { "#add" } else { "" }) {
                let _ = window.navigate(url);
            }
        }
        _ => {
            // "go:<i>": switch to a saved office
            let Some(i) = id.strip_prefix("go:").and_then(|i| i.parse::<usize>().ok()) else { return };
            let shell = app.state::<Shell>();
            let target = {
                let mut offices = shell.offices.lock().unwrap();
                let Some(url) = offices.list.get(i).map(|o| o.url.clone()) else { return };
                offices.open(&url);
                url
            };
            let _ = shell.save();
            refresh_menus(app);
            show(&window);
            if let Ok(url) = Url::parse(&target) {
                let _ = window.navigate(url);
            }
        }
    }
}

fn main() {
    let args = args();
    let mut builder = tauri::Builder::default();
    // Launching the app again (Start menu, a shortcut) brings back the window hidden in the tray. Only for
    // the default profile: one started with its own --data-dir (another profile, a test) runs alongside.
    if args.data_dir.is_none() {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window(MAIN) {
                show(&window);
            }
        }));
    }
    builder
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![list_offices, open_office, remove_office])
        .setup(move |app| {
            let dir = match &args.data_dir {
                Some(d) => d.clone(),
                None => app.path().app_local_data_dir()?,
            };
            let offices: Offices = std::fs::read(dir.join("offices.json"))
                .ok()
                .and_then(|b| serde_json::from_slice(&b).ok())
                .unwrap_or_default();
            let cli_office = args.office.as_deref().and_then(|o| office::parse(o).ok());
            let start = args
                .office
                .as_deref()
                .or(offices.current.as_deref())
                .and_then(|o| office::parse(o).ok())
                .map(WebviewUrl::External)
                .unwrap_or_else(|| WebviewUrl::App("index.html".into()));
            let page = match &start {
                WebviewUrl::External(url) => Some(url.clone()),
                _ => None,
            };
            app.manage(Shell { dir: dir.clone(), offices: Mutex::new(offices), cli_office, page: Mutex::new(page) });
            open_window(app.handle(), start, dir.join("webview"))?;
            // the tray brings a hidden window back on Windows and Linux; on a Mac the Dock does
            #[cfg(not(target_os = "macos"))]
            tray(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if QUITTING.load(Ordering::SeqCst) {
                    return;
                }
                api.prevent_close();
                if let Some(window) = window.app_handle().get_webview_window(window.label()) {
                    hide(&window);
                }
            }
        })
        .on_menu_event(|app, event| on_menu(app, event.id().as_ref()))
        .build(tauri::generate_context!())
        .expect("error while starting Home Quarters")
        .run(|_app, event| match event {
            // the Dock's Quit, Cmd+Q from the system, a log-out: leave for real
            tauri::RunEvent::ExitRequested { .. } => QUITTING.store(true, Ordering::SeqCst),
            // a click on the Dock icon brings back the window hidden by its close button
            #[cfg(target_os = "macos")]
            tauri::RunEvent::Reopen { .. } => {
                if let Some(window) = _app.get_webview_window(MAIN) {
                    show(&window);
                }
            }
            _ => {}
        });
}
