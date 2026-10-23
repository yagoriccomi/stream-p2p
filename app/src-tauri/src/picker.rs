// Chromium's screen-share picker, driven out of sight. The WebView2 has no API to capture a given
// source, so getDisplayMedia always opens that picker; the person chooses in the app's own grid
// (T02) instead. The picker is drawn inside the app's own window (it has no window of its own to
// hide), so `arm` covers the app with a still picture of itself, selects the same source and
// presses Share through UI Automation underneath, then lifts the picture. If a step fails the
// picture goes away with the picker still open for a manual choice: the stream never waits on an
// invisible dialog.
use std::{
    collections::HashSet,
    thread,
    time::{Duration, Instant},
};
use windows::{
    core::{w, Result},
    Win32::{
        Foundation::{COLORREF, HWND, LPARAM, LRESULT, POINT, RECT, SIZE, WPARAM},
        Graphics::Gdi::{
            BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, ReleaseDC, SelectObject,
            AC_SRC_OVER, BLENDFUNCTION, CAPTUREBLT, HBITMAP, HDC, SRCCOPY,
        },
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_MULTITHREADED},
            LibraryLoader::GetModuleHandleW,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement, IUIAutomationInvokePattern, IUIAutomationSelectionItemPattern,
                TreeScope_Descendants, UIA_ClassNamePropertyId, UIA_InvokePatternId, UIA_SelectionItemPatternId,
            },
            WindowsAndMessaging::{
                CreateWindowExW, DefWindowProcW, DestroyWindow, GetWindowRect, GetWindowTextW, RegisterClassW, ShowWindow,
                UpdateLayeredWindow, SW_SHOWNOACTIVATE, ULW_ALPHA, WNDCLASSW, WS_EX_LAYERED, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
                WS_EX_TOPMOST, WS_EX_TRANSPARENT, WS_POPUP,
            },
        },
    },
};

const FIND_TIMEOUT: Duration = Duration::from_secs(3); // getDisplayMedia opens it right away
const STEP_TIMEOUT: Duration = Duration::from_secs(3);
const POLL: Duration = Duration::from_millis(30);
const TAB_SETTLE: Duration = Duration::from_millis(300); // the other tab's sources leave the tree
const REPAINT: Duration = Duration::from_millis(100); // a few frames for the app to repaint without it
// Class names of the picker's views (stable across Chromium versions and languages).
const ROOT: &str = "RootView";
const TAB: &str = "TabbedPaneTab";
const SOURCE: &str = "DesktopMediaSourceView";
const BUTTON: &str = "MdTextButton";

pub enum Target {
    Window(String), // title, as the picker lists it
    Monitor(usize), // position, as the picker numbers screens
}

pub fn window_title(hwnd: isize) -> String {
    let mut buf = [0u16; 512];
    let n = unsafe { GetWindowTextW(HWND(hwnd as _), &mut buf) };
    String::from_utf16_lossy(&buf[..n.max(0) as usize])
}

pub fn arm(app: isize, target: Target) {
    // Taken now, before getDisplayMedia runs, so the picture never shows the picker.
    let shot = Snapshot::of(app);
    thread::spawn(move || {
        let cover = shot.map(|s| s.cover());
        let done = unsafe { choose(app, &target) };
        drop(cover);
        if let Err(e) = done {
            eprintln!("seletor: {e}; fica visível para escolher na mão");
        }
    });
}

fn wait<T>(timeout: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if let Some(v) = f() {
            return Some(v);
        }
        thread::sleep(POLL);
    }
    None
}

// The app window as it looks on screen right now.
struct Snapshot {
    at: RECT,
    dc: HDC,
    bitmap: HBITMAP,
}

impl Snapshot {
    fn of(app: isize) -> Option<Self> {
        unsafe {
            let mut at = RECT::default();
            GetWindowRect(HWND(app as _), &mut at).ok()?;
            let (w, h) = (at.right - at.left, at.bottom - at.top);
            let screen = GetDC(None);
            let dc = CreateCompatibleDC(Some(screen));
            let bitmap = CreateCompatibleBitmap(screen, w, h);
            SelectObject(dc, bitmap.into());
            let copied = BitBlt(dc, 0, 0, w, h, Some(screen), at.left, at.top, SRCCOPY | CAPTUREBLT);
            ReleaseDC(None, screen);
            let shot = Self { at, dc, bitmap };
            copied.ok().map(|_| shot)
        }
    }

    // A topmost, click-through window showing the picture exactly over the app.
    fn cover(&self) -> Cover {
        unsafe extern "system" fn proc(h: HWND, m: u32, w: WPARAM, l: LPARAM) -> LRESULT {
            DefWindowProcW(h, m, w, l)
        }
        unsafe {
            let instance = GetModuleHandleW(None).unwrap_or_default();
            let class = w!("StreamP2PCover");
            RegisterClassW(&WNDCLASSW { lpfnWndProc: Some(proc), hInstance: instance.into(), lpszClassName: class, ..Default::default() });
            let (w, h) = (self.at.right - self.at.left, self.at.bottom - self.at.top);
            let ex = WS_EX_LAYERED | WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE | WS_EX_TRANSPARENT;
            let Ok(hwnd) = CreateWindowExW(ex, class, None, WS_POPUP, self.at.left, self.at.top, w, h, None, None, Some(instance.into()), None)
            else {
                return Cover(None);
            };
            let blend = BLENDFUNCTION { BlendOp: AC_SRC_OVER as u8, SourceConstantAlpha: 255, ..Default::default() };
            let pos = POINT { x: self.at.left, y: self.at.top };
            let _ = UpdateLayeredWindow(hwnd, None, Some(&pos), Some(&SIZE { cx: w, cy: h }), Some(self.dc), Some(&POINT::default()), COLORREF(0), Some(&blend), ULW_ALPHA);
            let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
            Cover(Some(hwnd))
        }
    }
}

impl Drop for Snapshot {
    fn drop(&mut self) {
        unsafe {
            let _ = DeleteObject(self.bitmap.into());
            let _ = DeleteDC(self.dc);
        }
    }
}

// Snapshot is only touched by the thread that shows it.
unsafe impl Send for Snapshot {}

struct Cover(Option<HWND>);

impl Drop for Cover {
    fn drop(&mut self) {
        if let Some(hwnd) = self.0 {
            let _ = unsafe { DestroyWindow(hwnd) };
        }
    }
}

fn err(msg: &str) -> windows::core::Error {
    windows::core::Error::new(windows::core::HRESULT(-1), msg)
}

unsafe fn choose(app: isize, target: &Target) -> Result<()> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
    let ua: IUIAutomation = CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
    let window = ua.ElementFromHandle(HWND(app as _))?;
    // The picker's tabs show up inside the app window; their RootView ancestor is the picker.
    let is_tab = ua.CreatePropertyCondition(UIA_ClassNamePropertyId, &TAB.into())?;
    let tab = wait(FIND_TIMEOUT, || window.FindFirst(TreeScope_Descendants, &is_tab).ok()).ok_or_else(|| err("o seletor não abriu"))?;
    let walker = ua.RawViewWalker()?;
    let mut root = tab;
    while root.CurrentClassName().map(|s| s.to_string()).unwrap_or_default() != ROOT {
        root = walker.GetParentElement(&root)?;
    }

    let all = || -> Vec<(IUIAutomationElement, String)> {
        let Ok(found) = ua.CreateTrueCondition().and_then(|c| root.FindAll(TreeScope_Descendants, &c)) else { return Vec::new() };
        (0..found.Length().unwrap_or(0))
            .filter_map(|i| found.GetElement(i).ok())
            .map(|e| {
                let class = e.CurrentClassName().map(|s| s.to_string()).unwrap_or_default();
                (e, class)
            })
            .collect()
    };
    let named = |class: &str| all().into_iter().filter(|(_, c)| c == class).map(|(e, _)| e).collect::<Vec<_>>();
    let enabled_buttons = || -> HashSet<String> {
        named(BUTTON)
            .into_iter()
            .filter(|e| e.CurrentIsEnabled().map(|b| b.as_bool()).unwrap_or(false))
            .filter_map(|e| e.CurrentName().ok().map(|s| s.to_string()))
            .collect()
    };

    // Tabs: windows first, the whole screen last (the picker's order in every language).
    let tabs = named(TAB);
    let tab = match target {
        Target::Window(_) => tabs.first(),
        Target::Monitor(_) => tabs.last(),
    };
    tab.ok_or_else(|| err("aba"))?.GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)?.Select()?;
    thread::sleep(TAB_SETTLE);

    let source = wait(STEP_TIMEOUT, || {
        let list = named(SOURCE);
        match target {
            Target::Monitor(i) => list.into_iter().nth(*i),
            Target::Window(title) => {
                let name = |e: &IUIAutomationElement| e.CurrentName().map(|s| s.to_string()).unwrap_or_default();
                let exact = list.iter().find(|e| name(e) == *title).cloned();
                exact.or_else(|| list.into_iter().find(|e| !title.is_empty() && name(e).contains(title.as_str())))
            }
        }
    })
    .ok_or_else(|| err("fonte não está na lista do seletor"))?;
    // Share is the button that turns on once a source is picked; Cancel was on all along.
    let before = enabled_buttons();
    source.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?.Invoke()?;
    let share = wait(STEP_TIMEOUT, || {
        let on = enabled_buttons();
        named(BUTTON).into_iter().find(|e| {
            let n = e.CurrentName().map(|s| s.to_string()).unwrap_or_default();
            on.contains(&n) && !before.contains(&n)
        })
    })
    .ok_or_else(|| err("botão de compartilhar não ligou"))?;
    share.GetCurrentPatternAs::<IUIAutomationInvokePattern>(UIA_InvokePatternId)?.Invoke()?;
    // Chromium closes the picker a few frames after Share; the picture stays until it is gone.
    wait(STEP_TIMEOUT, || window.FindFirst(TreeScope_Descendants, &is_tab).is_err().then_some(()));
    thread::sleep(REPAINT);
    Ok(())
}
