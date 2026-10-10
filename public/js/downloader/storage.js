// storage.js — file system downloading, retries, and persistence
import { Filesystem, CapacitorHttp } from "../utils/index.js";
import { translations } from "../i18n/index.js";
import { currentLang } from "../modules/core.js";

function browserSafeHeaders(input = {}) {
  const blocked = new Set([
    "cookie",
    "host",
    "origin",
    "referer",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "user-agent",
  ]);
  return Object.fromEntries(
    Object.entries(input).filter(([name]) => !blocked.has(name.toLowerCase())),
  );
}

async function responseError(response) {
  try {
    const payload = await response.json();
    return payload?.error || payload?.detail || `Download failed (${response.status})`;
  } catch (_) {
    return `Download failed (${response.status})`;
  }
}

async function saveBlobWithBrowser(blob, fileName) {
  if (typeof window.showSaveFilePicker === "function") {
    try {
      const handle = await window.showSaveFilePicker({ suggestedName: fileName });
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return;
    } catch (error) {
      // A user cancellation is final; unsupported/expired user activation falls back to an anchor.
      if (error?.name === "AbortError") throw error;
    }
  }

  const objectUrl = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = fileName;
    anchor.style.display = "none";
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30_000);
  }
}

async function saveWithBrowser(actualDownloadUrl, fileName, downloadHeaders) {
  const controller = new AbortController();
  window._moriWebDownloadAbort = controller;
  let response;
  try {
    response = await fetch("api/download", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Mori-Web": "1",
      },
      body: JSON.stringify({
        url: actualDownloadUrl,
        filename: fileName,
        headers: downloadHeaders || {},
      }),
      signal: controller.signal,
    });

    if (!response.ok) throw new Error(await responseError(response));
    await saveBlobWithBrowser(await response.blob(), fileName);
    return { path: fileName, uri: fileName, web: true };
  } catch (gatewayError) {
    if (controller.signal.aborted || gatewayError?.name === "AbortError") throw gatewayError;
    console.warn("[Mori Web] Gateway download failed; trying direct CORS download:", gatewayError);

    try {
      response = await fetch(actualDownloadUrl, {
        headers: browserSafeHeaders(downloadHeaders),
        credentials: "omit",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`Media server returned ${response.status}`);
      await saveBlobWithBrowser(await response.blob(), fileName);
      return { path: fileName, uri: fileName, web: true };
    } catch (directError) {
      if (controller.signal.aborted || directError?.name === "AbortError") throw directError;
      // Last resort delegates the URL to the browser; some cross-origin servers ignore download=.
      const anchor = document.createElement("a");
      anchor.href = actualDownloadUrl;
      anchor.download = fileName;
      anchor.target = "_blank";
      anchor.rel = "noopener noreferrer";
      anchor.click();
      return { path: fileName, uri: actualDownloadUrl, web: true, delegated: true };
    }
  } finally {
    if (window._moriWebDownloadAbort === controller) window._moriWebDownloadAbort = null;
  }
}

/**
 * Removes temporary .tmp files across all search directories
 */
export async function cleanupTempFiles(fullPath, targetName, directoriesToTry) {
  if (!Filesystem || !targetName) return;
  const tempName = targetName.endsWith(".tmp") ? targetName : `${targetName}.tmp`;
  for (const dir of directoriesToTry) {
    await Filesystem.deleteFile({
      path: fullPath + "/" + tempName,
      directory: dir,
    }).catch(() => {});
  }
}

/**
 * Deletes saved file across directories (e.g. after cancellation)
 */
export async function deleteSavedFile(savedFile, directoriesToTry) {
  if (!Filesystem || !savedFile?.path) return;
  for (const dir of directoriesToTry) {
    await Filesystem.deleteFile({
      path: savedFile.path,
      directory: dir,
    }).catch(() => {});
  }
}

/**
 * Executes file download using Tauri, Capacitor Filesystem, or CapacitorHttp fallback
 */
export async function saveToStorage({
  actualDownloadUrl,
  fileName,
  fullPath,
  targetFolder,
  downloadHeaders,
  directoriesToTry,
  checkCancelled,
}) {
  let savedFile = null;
  let successfulDir = "EXTERNAL_STORAGE";
  let attempts = 0;

  const isAutoRetry = localStorage.getItem("mori_auto_retry") !== "false";
  const customMaxRetry = parseInt(
    localStorage.getItem("mori_max_retry") || "3",
    10,
  );
  const maxAttempts = isAutoRetry ? customMaxRetry : 1;

  const tauriInvoke =
    window.__TAURI__?.core?.invoke ||
    window.__TAURI_INTERNALS__?.invoke ||
    window.__TAURI__?.invoke;

  // 1. Desktop / Tauri Invocation
  if (tauriInvoke) {
    try {
      const desktopRes = await tauriInvoke("tauri_download_file", {
        url: actualDownloadUrl,
        filename: fileName,
        folder: fullPath || targetFolder || "",
        headers: downloadHeaders || {},
      });
      if (desktopRes && desktopRes.status) {
        savedFile = { path: desktopRes.path, uri: desktopRes.uri };
      }
    } catch (tErr) {
      console.warn("Tauri native download failed:", tErr);
      throw new Error(
        typeof tErr === "string"
          ? tErr
          : tErr?.message || JSON.stringify(tErr),
      );
    }
  }

  // 2. Browser download through the same-origin gateway (with direct fallback).
  if (!tauriInvoke && !Filesystem) {
    if (checkCancelled()) {
      return { savedFile: null, successfulDir: "BROWSER", cancelled: true };
    }
    try {
      savedFile = await saveWithBrowser(actualDownloadUrl, fileName, downloadHeaders);
    } catch (error) {
      if (checkCancelled() || error?.name === "AbortError") {
        return { savedFile: null, successfulDir: "BROWSER", cancelled: true };
      }
      throw error;
    }
    return { savedFile, successfulDir: "BROWSER", cancelled: false };
  }

  // 3. Mobile / Capacitor Filesystem Download
  const tempFileName = `${fileName}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.tmp`;

  if (!savedFile && Filesystem) {
    for (const dir of directoriesToTry) {
      if (savedFile) break;
      attempts = 0;
      while (attempts < maxAttempts && !savedFile) {
        if (checkCancelled()) {
          await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
          return { savedFile: null, successfulDir, cancelled: true };
        }
        attempts++;
        try {
          if (attempts > 1) {
            await new Promise((r) => setTimeout(r, 1000));
          }
          const isBypassSsl =
            localStorage.getItem("mori_bypass_ssl") === "true";
          const isForceIpv4 =
            localStorage.getItem("mori_force_ipv4") === "true";

          const dlOpts = {
            url: actualDownloadUrl,
            path: fullPath + "/" + tempFileName,
            directory: dir,
            progress: true,
            headers: downloadHeaders,
          };
          if (isBypassSsl) dlOpts.disableSSLValidation = true;
          if (isForceIpv4) dlOpts.ipv4Only = true;

          const tempSaved = await Filesystem.downloadFile(dlOpts);
          if (tempSaved) {
            // Rename .tmp to actual file name atomically on completion
            try {
              await Filesystem.rename({
                from: fullPath + "/" + tempFileName,
                to: fullPath + "/" + fileName,
                directory: dir,
              });
              savedFile = { path: fullPath + "/" + fileName };
            } catch (_) {
              // Fallback copy if rename unsupported
              await Filesystem.copy({
                from: fullPath + "/" + tempFileName,
                to: fullPath + "/" + fileName,
                directory: dir,
              });
              await Filesystem.deleteFile({
                path: fullPath + "/" + tempFileName,
                directory: dir,
              }).catch(() => {});
              savedFile = { path: fullPath + "/" + fileName };
            }
            successfulDir = dir;
          }
        } catch (dlErr) {
          console.warn(
            `Download attempt ${attempts} on ${dir} failed:`,
            dlErr,
          );
          // Clean up leftover .tmp file on error
          await Filesystem.deleteFile({
            path: fullPath + "/" + tempFileName,
            directory: dir,
          }).catch(() => {});

          // Fallback to CapacitorHttp blob download if retries exhausted
          if (attempts >= maxAttempts && CapacitorHttp) {
            try {
              const httpRes = await CapacitorHttp.get({
                url: actualDownloadUrl,
                responseType: "blob",
                headers: downloadHeaders,
                connectTimeout: 20000,
                readTimeout: 30000,
              });
              if (
                httpRes &&
                httpRes.status === 200 &&
                httpRes.data &&
                typeof httpRes.data === "string"
              ) {
                await Filesystem.writeFile({
                  path: fullPath + "/" + fileName,
                  data: httpRes.data,
                  directory: dir,
                });
                savedFile = { path: fullPath + "/" + fileName };
                successfulDir = dir;
              }
            } catch (fallbackErr) {
              console.warn(
                `Http blob fallback on ${dir} failed:`,
                fallbackErr,
              );
            }
          }
        }
      }
    }
  }

  if (!savedFile) {
    if (checkCancelled()) {
      await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
      return { savedFile: null, successfulDir, cancelled: true };
    }
    await cleanupTempFiles(fullPath, tempFileName, directoriesToTry);
    throw new Error(
      translations[currentLang]?.["toast-download-failed"] || "Download failed",
    );
  }

  if (checkCancelled()) {
    await deleteSavedFile(savedFile, directoriesToTry);
    return { savedFile: null, successfulDir, cancelled: true };
  }

  return { savedFile, successfulDir, cancelled: false };
}
