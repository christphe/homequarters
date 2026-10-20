//! The characters printed on the keyboard's keys, by physical position (KeyboardEvent.code), for the
//! navigator.keyboard.getLayoutMap the app gives the page (src/missing-apis.js). Read on macOS only, where
//! WKWebView lacks the Keyboard API; WebView2 has its own. macOS wants these calls on the main thread.

use std::collections::BTreeMap;

/// Physical key positions and their macOS virtual key codes (ANSI layout, Events.h).
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const KEYS: &[(&str, u16)] = &[
    ("KeyA", 0x00), ("KeyS", 0x01), ("KeyD", 0x02), ("KeyF", 0x03), ("KeyH", 0x04), ("KeyG", 0x05),
    ("KeyZ", 0x06), ("KeyX", 0x07), ("KeyC", 0x08), ("KeyV", 0x09), ("IntlBackslash", 0x0A), ("KeyB", 0x0B),
    ("KeyQ", 0x0C), ("KeyW", 0x0D), ("KeyE", 0x0E), ("KeyR", 0x0F), ("KeyY", 0x10), ("KeyT", 0x11),
    ("Digit1", 0x12), ("Digit2", 0x13), ("Digit3", 0x14), ("Digit4", 0x15), ("Digit6", 0x16), ("Digit5", 0x17),
    ("Equal", 0x18), ("Digit9", 0x19), ("Digit7", 0x1A), ("Minus", 0x1B), ("Digit8", 0x1C), ("Digit0", 0x1D),
    ("BracketRight", 0x1E), ("KeyO", 0x1F), ("KeyU", 0x20), ("BracketLeft", 0x21), ("KeyI", 0x22), ("KeyP", 0x23),
    ("KeyL", 0x25), ("KeyJ", 0x26), ("Quote", 0x27), ("KeyK", 0x28), ("Semicolon", 0x29), ("Backslash", 0x2A),
    ("Comma", 0x2B), ("Slash", 0x2C), ("KeyN", 0x2D), ("KeyM", 0x2E), ("Period", 0x2F), ("Backquote", 0x32),
];

#[cfg(target_os = "macos")]
mod mac {
    use std::ffi::c_void;

    #[link(name = "Carbon", kind = "framework")]
    extern "C" {
        pub static kTISPropertyUnicodeKeyLayoutData: *const c_void;
        pub fn TISCopyCurrentKeyboardLayoutInputSource() -> *mut c_void;
        pub fn TISGetInputSourceProperty(source: *mut c_void, key: *const c_void) -> *const c_void;
        pub fn LMGetKbdType() -> u8;
        pub fn UCKeyTranslate(
            layout: *const u8,
            virtual_key_code: u16,
            key_action: u16,
            modifier_key_state: u32,
            keyboard_type: u32,
            key_translate_options: u32,
            dead_key_state: *mut u32,
            max_string_length: usize,
            actual_string_length: *mut usize,
            unicode_string: *mut u16,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        pub fn CFDataGetBytePtr(data: *const c_void) -> *const u8;
        pub fn CFRelease(cf: *const c_void);
    }

    pub const KEY_ACTION_DISPLAY: u16 = 3; // kUCKeyActionDisplay
    pub const NO_DEAD_KEYS: u32 = 1; // kUCKeyTranslateNoDeadKeysMask
}

/// What each key types without modifiers, in lower case like Chromium's layout map; None where it is not
/// read (other systems, or an input source with no keyboard layout data).
pub fn current() -> Option<BTreeMap<&'static str, String>> {
    #[cfg(target_os = "macos")]
    unsafe {
        use mac::*;
        let source = TISCopyCurrentKeyboardLayoutInputSource();
        if source.is_null() {
            return None;
        }
        let data = TISGetInputSourceProperty(source, kTISPropertyUnicodeKeyLayoutData);
        let mut out = BTreeMap::new();
        if !data.is_null() {
            let layout = CFDataGetBytePtr(data);
            let kind = LMGetKbdType() as u32;
            for &(code, vk) in KEYS {
                let (mut dead, mut len, mut buf) = (0u32, 0usize, [0u16; 4]);
                let status = UCKeyTranslate(layout, vk, KEY_ACTION_DISPLAY, 0, kind, NO_DEAD_KEYS, &mut dead, buf.len(), &mut len, buf.as_mut_ptr());
                if status == 0 && len > 0 {
                    let s = String::from_utf16_lossy(&buf[..len]).to_lowercase();
                    if !s.trim().is_empty() {
                        out.insert(code, s);
                    }
                }
            }
        }
        CFRelease(source as *const _);
        return if out.is_empty() { None } else { Some(out) };
    }
    #[allow(unreachable_code)]
    None
}

/// Whether this system's web view needs the app's layout map.
pub const MEASURED: bool = cfg!(target_os = "macos");

#[cfg(test)]
mod tests {
    use super::KEYS;

    #[test]
    fn every_position_has_one_key_code() {
        let mut codes: Vec<_> = KEYS.iter().map(|k| k.1).collect();
        codes.sort();
        codes.dedup();
        assert_eq!(codes.len(), KEYS.len());
        assert!(KEYS.iter().any(|k| k.0 == "KeyW") && KEYS.iter().any(|k| k.0 == "Digit1"));
    }
}
