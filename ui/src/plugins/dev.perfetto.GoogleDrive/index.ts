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
import type {Flag} from '../../public/feature_flag';
import type {PerfettoPlugin} from '../../public/plugin';
import type {RouteArgs} from '../../public/route_schema';
import type {Trace} from '../../public/trace';
import {showModal} from '../../widgets/modal';
import {
  GDriveClient,
  isValidDriveId,
  parseGDriveStateParam,
} from './gdrive/gdrive_client';
import {GoogleOAuthClient} from './gdrive/oauth_client';
import {loadGDriveConfig} from './gdrive_config';
import {alertModal} from './modal_prompt';
import {openFileFromDeeplink} from './open_from_deeplink';
import {openFileFromSidebar} from './open_from_sidebar';
import {ShareForm, type ShareState} from './share_form';
import {
  openGDriveSharingDialog,
  pickUploadFolder,
  uploadTraceToGDrive,
} from './share_to_gdrive';
import {GDRIVE_PLUGIN_ID, parseGDriveTraceArgs} from './trace_args';
import './styles.scss';

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
  static readonly id = GDRIVE_PLUGIN_ID;
  static readonly description = 'Open and save traces to Google Drive';

  // Set once initGDrive() has succeeded. Stays undefined if it fails. Static,
  // as it is loaded once in onActivate() and used by every trace.
  private static clients: GDriveClients | undefined;

  // Registered in onActivate(), which always runs before onTraceLoad().
  private static allowExternalUsersSetting: Flag;

  // Only expose Google Drive buttons to internal users, or to anyone with the
  // flag registered in onActivate().
  private static shouldEnableDriveFeatures(app: App): boolean {
    return (
      app.isInternalUser || GoogleDrivePlugin.allowExternalUsersSetting.get()
    );
  }

  // What the "Share to Google Drive" dialog shows for this trace. It lives
  // here, on the per-trace plugin instance, rather than in the dialog, so that
  // an upload carries on being shown, cancellable and able to report failure
  // if the dialog is closed and reopened.
  private readonly share: ShareState = {
    fileName: '',
    location: 'root',
    fileId: undefined,
    upload: undefined,
    error: undefined,
  };

  static onActivate(app: App, pluginArgs: RouteArgs) {
    // Google clients are odd - we must run them as external scripts so loading
    // their code naturally is asynchronous. We don't want to delay startup so
    // kick off the load async and hide features until they've loaded.
    const clientsPromise = initGDrive(app).then(
      (c) => (GoogleDrivePlugin.clients = c),
    );

    // Shows the Google Drive buttons to users who are not internal, so the
    // feature can be tried with external accounts ahead of a wider launch.
    // Keep this disabled during the soak period.
    GoogleDrivePlugin.allowExternalUsersSetting = app.featureFlags.register({
      id: 'dev.perfetto.GoogleDriveAllowExternalUsers',
      name: 'Enable Google Drive integration for external users',
      description:
        'Shows the Google Drive buttons to users who are not internal. For ' +
        'testing ahead of launch.',
      defaultValue: false,
    });

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
      visible: () =>
        GoogleDrivePlugin.shouldEnableDriveFeatures(app) &&
        GoogleDrivePlugin.clients !== undefined,
      action: async () => {
        const clients = GoogleDrivePlugin.clients;
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

        // Ignore a 'state' param that is not a Drive "Open with" payload.
        const parsed = parseGDriveStateParam(state);
        if (!parsed.ok) return;

        openFileFromDeeplink(app, clients.oauth, clients.drive, parsed.value);
      }
    });

    // The share links generated by "Copy link" in the "Share to Google Drive"
    // dialog: #!/?dev.perfetto.GoogleDrive:openFileId=<id>. Like the deep link
    // above, these work for any user.
    const openFileId = pluginArgs['openFileId'];
    // Like a malformed 'state', ignore an ID that cannot be a Drive file ID
    // rather than asking the user to connect for it.
    if (typeof openFileId === 'string' && isValidDriveId(openFileId)) {
      clientsPromise.then((clients) => {
        if (!clients) {
          alertGDriveNotAvailable();
          return;
        }

        openFileFromDeeplink(app, clients.oauth, clients.drive, {
          fileId: openFileId,
        });
      });
    }
  }

  async onTraceLoad(
    trace: Trace,
    args?: {[key: string]: unknown},
  ): Promise<void> {
    const share = this.share;
    share.fileName = trace.traceInfo.traceTitle;
    // If the trace was opened from Drive, it is already there.
    share.fileId = parseGDriveTraceArgs(args);

    // Stop an upload that is still running when the trace is closed. Nothing
    // could show or cancel it any more, and it would keep the trace's contents
    // alive until it finished.
    trace.trash.defer(() => share.upload?.controller.abort());

    // The button reflects the share state, so that an upload can be followed,
    // and its outcome seen, while the dialog is closed. These callbacks run on
    // every render, and the upload's progress reports trigger a redraw.
    trace.sidebar.addMenuItem({
      section: 'current_trace',
      text: () =>
        isSavedToDrive(share) ? 'Saved to GDrive' : 'Share to GDrive',
      icon: () => {
        if (share.upload !== undefined) return 'add_to_drive';
        if (isSavedToDrive(share)) return 'cloud_done';
        // The last action in the share dialog failed.
        if (share.error !== undefined) return 'error';
        return 'add_to_drive';
      },
      sortOrder: 10,
      // While uploading, the badge shows how far the upload has got.
      badge: () => {
        const upload = share.upload;
        if (upload === undefined) return 'preview';
        if (upload.totalBytes === 0) return '…';
        return `${Math.floor((100 * upload.uploadedBytes) / upload.totalBytes)}%`;
      },
      // Same rules as "Open from GDrive", and only for traces whose contents
      // can be read back to upload (not, for example, one loaded over
      // HTTP+RPC).
      visible: () =>
        GoogleDrivePlugin.shouldEnableDriveFeatures(trace) &&
        GoogleDrivePlugin.clients !== undefined &&
        trace.traceInfo.downloadable,
      action: () => {
        const clients = GoogleDrivePlugin.clients;
        assertDefined(clients); // Gated by the visible check above
        const {oauth, drive} = clients;

        // Each action runs outside of any DOM event handler once it awaits, so
        // redraw when it finishes to show the outcome.
        const redrawAfter = (action: Promise<void>) => {
          action.finally(() => trace.raf.scheduleFullRedraw());
        };

        // This button opens a modal dialog which displays the state of the file
        // in google drive allowing the user to upload it and optionally share
        // it. The dialog renders this.share, and keeps no state of its own.
        showModal({
          key: 'GDriveUpload',
          title: 'Share to Google Drive',
          icon: 'cloud_upload',
          content: () =>
            m(ShareForm, {
              state: share,
              onFileNameChange: (fileName: string) => {
                share.fileName = fileName;
              },
              onUpload: () =>
                redrawAfter(uploadTraceToGDrive(trace, oauth, drive, share)),
              onCancelUpload: () => share.upload?.controller.abort(),
              onPickFolder: () =>
                redrawAfter(pickUploadFolder(oauth, drive, share)),
              onOpenSharingDialog: () =>
                redrawAfter(openGDriveSharingDialog(oauth, drive, share)),
            }),
        });
      },
    });
  }
}

// Whether the trace is known to be in Drive, either uploaded or opened from
// there.
function isSavedToDrive(share: Readonly<ShareState>): boolean {
  return share.fileId !== undefined && share.fileId !== '';
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
