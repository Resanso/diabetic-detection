export type ThemePref = "terang" | "gelap" | "sistem";

const KEY = "retinova.theme";
const THEME_COLOR = { light: "#FFFFFF", dark: "#161719" };
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "terang" || v === "gelap" || v === "sistem") return v;
  } catch {
    /* penyimpanan lokal tidak tersedia */
  }
  return "terang"; // bawaan brand: tema terang, terbaca di bawah matahari
}

function apply(pref: ThemePref) {
  const dark = pref === "gelap" || (pref === "sistem" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? THEME_COLOR.dark : THEME_COLOR.light);
}

export function setThemePref(pref: ThemePref) {
  try {
    localStorage.setItem(KEY, pref);
  } catch {
    /* penyimpanan lokal tidak tersedia */
  }
  apply(pref);
}

/** Dipanggil sekali saat aplikasi mulai: terapkan pilihan dan ikuti perubahan tema sistem. */
export function initTheme() {
  apply(getThemePref());
  media.addEventListener("change", () => getThemePref() === "sistem" && apply("sistem"));
}
