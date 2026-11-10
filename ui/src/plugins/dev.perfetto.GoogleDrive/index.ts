// Copyright (C) 2026 The Android Open Source Project
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import m from 'mithril';
import {assertDefined} from '../../base/assert';
import type {App} from '../../public/app';
import type {PerfettoPlugin} from '../../public/plugin';
import {GDriveClient} from './gdrive/gdrive_client';
import {GoogleOAuthClient} from './gdrive/oauth_client';
import {loadGDriveConfig} from './gdrive_config';
import {alertModal} from './modal_prompt';
import {openFileFromDeeplink} from './open_from_deeplink';
import {openFileFromSidebar} from './open_from_sidebar';

export interface GDriveClients {
  readonly oauth: GoogleOAuthClient;
  readonly drive: GDriveClient;
}

// The OAuth scopes to ask for when connecting to the user's Google account:
// reading files the user has opened or picked with the app (drive.file), and
// being offered in Drive's "Open with" menu (drive.install).
const GDRIVE_SCOPES =
  'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.install';

export default class GoogleDrivePlugin implements PerfettoPlugin {
  static readonly id = 'dev.perfetto.GoogleDrive';
  static readonly description = 'Open traces from Google Drive';

  static onActivate(app: App) {
    // Google clients are odd - we must run them as external scripts so loading
    // their code naturally is asynchronous. We don't want to delay startup so
    // kick off the load async and hide features until they've loaded.
    let clients: GDriveClients | undefined;
    const clientsPromise = initGDrive(app).then((c) => (clients = c));

    // Shows the Google Drive button to users who are not internal, so the
    // feature can be tried with external accounts ahead of a wider launch.
    // Keep this disabled during the soak period.
    const allowExternalUsersSetting = app.featureFlags.register({
      id: 'dev.perfetto.GoogleDriveAllowExternalUsers',
      name: 'Enable Google Drive integration for external users',
      description:
        'Shows the Google Drive buttons to users who are not internal. For ' +
        'testing ahead of launch.',
      defaultValue: false,
    });

    function shouldEnableDriveFeatures(): boolean {
      return app.isInternalUser || allowExternalUsersSetting.get();
    }

    function clientsLoaded() {
      return clients !== undefined;
    }

    let openFlowInProgress = false;

    app.sidebar.addMenuItem({
      section: 'trace_files',
      text: 'Open from GDrive',
      icon: 'drive_export',
      badge: 'preview',
      // Just below "Open trace file".
      sortOrder: 1.25,
      // Only expose the sidebar button to internal users (or anyone, with the
      // flag above), and only once everything it needs has loaded. This is a
      // callback as both are only resolved some time after startup.
      visible: () => shouldEnableDriveFeatures() && clientsLoaded(),
      action: async () => {
        assertDefined(clients); // Gated by the visible check above

        if (openFlowInProgress) {
          return;
        }

        openFlowInProgress = true;
        try {
          await openFileFromSidebar(app, clients.oauth, clients.drive);
        } finally {
          openFlowInProgress = false;
        }
      },
    });

    // When opening a trace directly from Google drive's UI, it passes the file
    // id and the resource keys in a hard-coded arg called 'state'. Intercept
    // this and load the file if these args are passed.
    // Note: We don't always know whether we are internalUser at this point and
    // there's no built-in way to await it, so while google drive features are
    // not supposed to be available to external users just yet, passing
    // '?state=...' in the URL will still work. This is acceptable as the
    // feature will be released to external users in the future - the soak
    // period is really about not advertising them.
    const state = app.initialRouteArgs['state'];
    clientsPromise.then((clients) => {
      if (typeof state === 'string') {
        if (!clients) {
          alertGDriveNotAvailable();
          return;
        }

        openFileFromDeeplink(app, clients.oauth, clients.drive, state);
      }
    });
  }
}

async function alertGDriveNotAvailable() {
  await alertModal({
    key: 'GoogleDriveUnavailable',
    title: 'Google Drive unavailable',
    content: m(
      'p',
      'Opening traces from Google Drive is not available right now.',
    ),
  });
}

// Loads everything Google Drive support needs, in order: the config, Google's
// sign-in library (for the OAuth client), then Google's API loader and its
// picker module (for the Drive client). This runs once, at startup, and
// nothing in it opens a popup.
//
// Returns undefined if any step fails. This is deliberately quiet (a console
// error only): it runs on every page load, including for users who are offline
// or block Google's scripts and never asked for Google Drive. The sidebar
// button stays hidden and the "Open with" deep link reports that Google Drive
// is unavailable.
async function initGDrive(app: App): Promise<GDriveClients | undefined> {
  try {
    const config = await loadGDriveConfig();
    const oauth = await GoogleOAuthClient.create({
      clientId: config.clientId,
      scope: GDRIVE_SCOPES,
    });
    const drive = await GDriveClient.create({
      appId: config.appId,
      apiKey: config.apiKey,
    });
    return {oauth, drive};
  } catch (e) {
    console.error('Failed to initialize Google Drive', e);
    return undefined;
  } finally {
    app.raf.scheduleFullRedraw();
  }
}
