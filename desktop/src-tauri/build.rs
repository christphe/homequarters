fn main() {
    // App commands are allowed by permission (allow-<command>): the bundled offices page gets the first
    // three (capabilities/setup.json), office pages only notify, added at run time per office (main.rs).
    let commands = &["list_offices", "open_office", "remove_office", "notify"];
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(commands)))
        .expect("tauri build script");
}
