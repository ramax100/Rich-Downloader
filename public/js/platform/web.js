function hasNativeRuntime() {
  return Boolean(
    window.MoriMainBridge ||
      window.MoriShareBridge ||
      window.__TAURI__ ||
      window.__TAURI_INTERNALS__ ||
      window.Capacitor?.isNativePlatform?.(),
  );
}

export const isWebRuntime = !hasNativeRuntime();

function webCopy() {
  const lang = localStorage.getItem("mori_language") || localStorage.getItem("language") || "en";
  if (lang === "id") {
    return {
      galleryDescription: "Unduhan disimpan oleh browser",
      galleryEmpty: "Browser tidak mengizinkan Mori memindai folder Unduhan. Lihat riwayat untuk membuka kembali sumber media.",
      browserManaged: "Dikelola browser",
      gatewayReady: "Gateway web siap",
      gatewayLimited: "Mode web terbatas: gateway tidak tersedia",
      guideDownload: 'Ketuk "Unduh" untuk menyimpan file melalui dialog unduhan browser dengan progres langsung.',
      guideHistory: "Riwayat mengingat sumber media. File yang tersimpan tersedia di folder Unduhan browser.",
    };
  }
  return {
    galleryDescription: "Downloads are managed by your browser",
    galleryEmpty: "Browsers do not allow Mori to scan your Downloads folder. Use History to revisit saved media sources.",
    browserManaged: "Browser managed",
    gatewayReady: "Web gateway ready",
    gatewayLimited: "Limited web mode: gateway unavailable",
    guideDownload: 'Tap "Download" to save through your browser with live progress.',
    guideHistory: "History remembers media sources. Saved files remain in your browser Downloads folder.",
  };
}

async function updateGatewayBadge(badge, copy) {
  try {
    const response = await fetch("/api/health", { cache: "no-store" });
    if (!response.ok) throw new Error("Gateway unavailable");
    badge.classList.add("is-ready");
    badge.title = copy.gatewayReady;
  } catch (_) {
    badge.classList.add("is-limited");
    badge.title = copy.gatewayLimited;
  }
}

function configureWebUi() {
  if (!isWebRuntime || document.body.dataset.moriWebReady === "true") return;
  document.body.dataset.moriWebReady = "true";
  document.body.classList.add("is-web");
  window.__MORI_WEB__ = true;

  const copy = webCopy();
  const title = document.querySelector("header h1");
  if (title && !document.querySelector(".web-runtime-badge")) {
    const badge = document.createElement("span");
    badge.className = "web-runtime-badge";
    badge.textContent = "WEB";
    badge.setAttribute("aria-label", "Web version");
    title.insertAdjacentElement("afterend", badge);
    updateGatewayBadge(badge, copy);
  }

  for (const id of ["changePathBtn", "changeMusicPathBtn", "allFilesAccessItem"]) {
    const element = document.getElementById(id);
    if (element) element.style.display = "none";
  }

  const storageValue = document.getElementById("storageSizeVal");
  if (storageValue) storageValue.textContent = copy.browserManaged;
  document.getElementById("checkUpdateBtn")?.classList.add("hidden");

  const galleryPage = document.getElementById("galleryPage");
  const galleryDescription = galleryPage?.querySelector(".page-header p");
  const galleryEmpty = galleryPage?.querySelector(".gallery-empty p");
  if (galleryDescription) {
    galleryDescription.removeAttribute("data-i18n");
    galleryDescription.textContent = copy.galleryDescription;
  }
  if (galleryEmpty) {
    galleryEmpty.removeAttribute("data-i18n");
    galleryEmpty.textContent = copy.galleryEmpty;
  }

  const guideDownload = document.querySelector('[data-i18n="guide-step-3"]');
  const guideHistory = document.querySelector('[data-i18n="guide-step-4"]');
  if (guideDownload) {
    guideDownload.removeAttribute("data-i18n");
    guideDownload.textContent = copy.guideDownload;
  }
  if (guideHistory) {
    guideHistory.removeAttribute("data-i18n");
    guideHistory.textContent = copy.guideHistory;
  }

  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("service-worker.js").catch((error) => {
      console.warn("[Mori Web] Service worker registration failed:", error);
    });
  }
}

if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", configureWebUi, { once: true });
else configureWebUi();
