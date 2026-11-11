//! The prebuilt skia.lib (renderer-skia) was compiled against the VS 2022 STL, which calls the
//! vectorized helpers below from msvcprt; this PC only has VS 2019 BuildTools, whose msvcprt lacks
//! them. Plain scalar versions with the same contract (MSVC STL vector_algorithms.cpp).
//! ponytail: remove once the build machine has the VS 2022 toolset (then msvcprt provides them).
#![allow(clippy::missing_safety_doc)]
use std::ffi::c_void;

unsafe fn slice<'a, T>(first: *const c_void, last: *const c_void) -> &'a [T] {
    std::slice::from_raw_parts(first as *const T, (last as usize - first as usize) / std::mem::size_of::<T>())
}

unsafe fn find<T: PartialEq + Copy>(first: *const c_void, last: *const c_void, v: T) -> *const c_void {
    let s = slice::<T>(first, last);
    s.iter().position(|&x| x == v).map_or(last, |i| s.as_ptr().add(i) as _)
}

#[no_mangle]
pub unsafe extern "C" fn __std_find_trivial_1(f: *const c_void, l: *const c_void, v: u8) -> *const c_void {
    find(f, l, v)
}
#[no_mangle]
pub unsafe extern "C" fn __std_find_trivial_4(f: *const c_void, l: *const c_void, v: u32) -> *const c_void {
    find(f, l, v)
}
#[no_mangle]
pub unsafe extern "C" fn __std_find_trivial_8(f: *const c_void, l: *const c_void, v: u64) -> *const c_void {
    find(f, l, v)
}
#[no_mangle]
pub unsafe extern "C" fn __std_find_last_trivial_1(f: *const c_void, l: *const c_void, v: u8) -> *const c_void {
    let s = slice::<u8>(f, l);
    s.iter().rposition(|&x| x == v).map_or(l, |i| s.as_ptr().add(i) as _)
}

/// First occurrence of needle [f2, f2+n2) in [f1, l1), or l1.
#[no_mangle]
pub unsafe extern "C" fn __std_search_1(f1: *const c_void, l1: *const c_void, f2: *const c_void, n2: usize) -> *const c_void {
    let (h, n) = (slice::<u8>(f1, l1), std::slice::from_raw_parts(f2 as *const u8, n2));
    if n.is_empty() {
        return f1;
    }
    h.windows(n.len()).position(|w| w == n).map_or(l1, |i| h.as_ptr().add(i) as _)
}

/// Index of the first byte of [f1, f1+n1) that is in [f2, f2+n2), or usize::MAX (npos).
#[no_mangle]
pub unsafe extern "C" fn __std_find_first_of_trivial_pos_1(f1: *const c_void, n1: usize, f2: *const c_void, n2: usize) -> usize {
    let (h, set) = (std::slice::from_raw_parts(f1 as *const u8, n1), std::slice::from_raw_parts(f2 as *const u8, n2));
    h.iter().position(|b| set.contains(b)).unwrap_or(usize::MAX)
}

/// First minimum / first maximum, like std::min_element / std::max_element.
unsafe fn extreme<T: Copy, F: Fn(T, T) -> bool>(f: *const c_void, l: *const c_void, better: F) -> *const c_void {
    let s = slice::<T>(f, l);
    let mut best = 0;
    for i in 1..s.len() {
        if better(s[i], s[best]) {
            best = i;
        }
    }
    if s.is_empty() { l } else { s.as_ptr().add(best) as _ }
}

#[no_mangle]
pub unsafe extern "C" fn __std_min_element_f(f: *const c_void, l: *const c_void, _u: bool) -> *const c_void {
    extreme::<f32, _>(f, l, |a, b| a < b)
}
#[no_mangle]
pub unsafe extern "C" fn __std_max_element_f(f: *const c_void, l: *const c_void, _u: bool) -> *const c_void {
    extreme::<f32, _>(f, l, |a, b| b < a)
}
#[no_mangle]
pub unsafe extern "C" fn __std_max_element_1(f: *const c_void, l: *const c_void, signed: bool) -> *const c_void {
    if signed { extreme::<i8, _>(f, l, |a, b| b < a) } else { extreme::<u8, _>(f, l, |a, b| b < a) }
}
#[no_mangle]
pub unsafe extern "C" fn __std_max_element_2(f: *const c_void, l: *const c_void, signed: bool) -> *const c_void {
    if signed { extreme::<i16, _>(f, l, |a, b| b < a) } else { extreme::<u16, _>(f, l, |a, b| b < a) }
}

#[repr(C)]
pub struct MinMax {
    min: *const c_void,
    max: *const c_void,
}

/// std::minmax_element: first minimum, *last* maximum.
#[no_mangle]
pub unsafe extern "C" fn __std_minmax_element_f(f: *const c_void, l: *const c_void, _u: bool) -> MinMax {
    let s = slice::<f32>(f, l);
    if s.is_empty() {
        return MinMax { min: l, max: l };
    }
    let (mut lo, mut hi) = (0, 0);
    for i in 1..s.len() {
        if s[i] < s[lo] {
            lo = i;
        }
        if !(s[i] < s[hi]) {
            hi = i;
        }
    }
    MinMax { min: s.as_ptr().add(lo) as _, max: s.as_ptr().add(hi) as _ }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shim_matches_std_semantics() {
        unsafe {
            let b = b"abcabc";
            let (f, l) = (b.as_ptr() as *const c_void, b.as_ptr().add(6) as *const c_void);
            assert_eq!(__std_find_trivial_1(f, l, b'c'), b.as_ptr().add(2) as _);
            assert_eq!(__std_find_trivial_1(f, l, b'z'), l);
            assert_eq!(__std_find_last_trivial_1(f, l, b'a'), b.as_ptr().add(3) as _);
            assert_eq!(__std_search_1(f, l, b"ca".as_ptr() as _, 2), b.as_ptr().add(2) as _);
            assert_eq!(__std_find_first_of_trivial_pos_1(f as _, 6, b"xc".as_ptr() as _, 2), 2);
            assert_eq!(__std_find_first_of_trivial_pos_1(f as _, 6, b"xy".as_ptr() as _, 2), usize::MAX);
            let v = [3.0f32, 1.0, 5.0, 1.0, 5.0];
            let (f, l) = (v.as_ptr() as *const c_void, v.as_ptr().add(5) as *const c_void);
            assert_eq!(__std_min_element_f(f, l, false), v.as_ptr().add(1) as _);
            assert_eq!(__std_max_element_f(f, l, false), v.as_ptr().add(2) as _);
            let mm = __std_minmax_element_f(f, l, false);
            assert_eq!((mm.min, mm.max), (v.as_ptr().add(1) as _, v.as_ptr().add(4) as _));
            let s = [-1i8, 2, 2];
            assert_eq!(__std_max_element_1(s.as_ptr() as _, s.as_ptr().add(3) as _, true), s.as_ptr().add(1) as _);
            assert_eq!(__std_max_element_1(s.as_ptr() as _, s.as_ptr().add(3) as _, false), s.as_ptr() as _); // 0xff unsigned
        }
    }
}
