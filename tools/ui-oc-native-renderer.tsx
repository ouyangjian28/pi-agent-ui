// Loaded only after native login/readiness. Never import legacy web entrypoints.
import React, { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@openchamber/ui/index.css';
import '@openchamber/ui/styles/fonts';
import App from '@openchamber/ui/App';
import { MobileApp } from '@openchamber/ui/apps/MobileApp';
import { DiffWorkerProvider } from '@openchamber/ui/contexts/DiffWorkerProvider';
import { ThemeProvider } from '@openchamber/ui/components/providers/ThemeProvider';
import { ThemeSystemProvider } from '@openchamber/ui/contexts/ThemeSystemContext';
import { SessionAuthGate } from '@openchamber/ui/components/auth/SessionAuthGate';
import { initializeLocale, I18nProvider } from '@openchamber/ui/lib/i18n';
import { initializeAppearancePreferences } from '@openchamber/ui/lib/persistence';
import { getDeviceInfo } from '@openchamber/ui/lib/device';
import { markAppBootReady } from '@openchamber/ui/apps/appBootReady';
import { preloadMarkdownRenderer } from '@openchamber/ui/components/chat/markdownRendererLoader';
import { createRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createWebAPIs } from '../vendor/openchamber-frontend/packages/web/src/api';
import { sealOriginalRuntimeAPIs } from './ui-oc-native-runtime-apis';
import { getNativeSurfaceHost, type NativeSurfaceHost } from '../apps/web/src/oc-bridge/native-surface-host';
import type { OriginalSurface } from '../apps/web/src/oc-bridge/native-original-startup';

export async function renderOriginalNativeSurface(host: NativeSurfaceHost, surface: OriginalSurface, element: HTMLElement): Promise<() => void> {
  if (getNativeSurfaceHost() !== host) throw new Error('Original surface must use the installed native host.');
  window.__OPENCHAMBER_SURFACE__ = surface;
  // No Source createConfiguredWebAPIs: no auth refresh, runtime switch, relay
  // restoration, provider/model prefs auto-save, PWA or viewport reload.
  const apis = sealOriginalRuntimeAPIs(createWebAPIs({ urls: createRuntimeUrlResolver({ apiBaseUrl: window.location.origin, realtimeBaseUrl: window.location.origin }) }));
  window.__OPENCHAMBER_RUNTIME_APIS__ = apis;
  initializeLocale(); getDeviceInfo(); preloadMarkdownRenderer();
  try { await initializeAppearancePreferences(); } finally { markAppBootReady(); }
  const root = createRoot(element);
  const app = surface === 'mobile' ? <MobileApp apis={apis} /> : <App apis={apis} />;
  root.render(<StrictMode><I18nProvider><ThemeSystemProvider><ThemeProvider><DiffWorkerProvider><SessionAuthGate>{app}</SessionAuthGate></DiffWorkerProvider></ThemeProvider></ThemeSystemProvider></I18nProvider></StrictMode>);
  return () => root.unmount();
}
