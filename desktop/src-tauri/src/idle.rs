//! How long the system has had no keyboard or pointer input, for the IdleDetector the app gives the page
//! (src/missing-apis.js). Measured on macOS only: WebView2 has its own IdleDetector.

#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
}

/// Seconds since the last input event of any kind, or None where the app does not measure it.
pub fn seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        const HID_SYSTEM_STATE: i32 = 1; // kCGEventSourceStateHIDSystemState: the hardware's own events
        const ANY_INPUT: u32 = u32::MAX; // kCGAnyInputEventType
        return Some(unsafe { CGEventSourceSecondsSinceLastEventType(HID_SYSTEM_STATE, ANY_INPUT) });
    }
    #[allow(unreachable_code)]
    None
}

/// Whether this system's web view needs the app's IdleDetector.
pub const MEASURED: bool = cfg!(target_os = "macos");
