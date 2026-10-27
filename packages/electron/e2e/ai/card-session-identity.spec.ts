/**
 * Card identity on session surfaces: chats launched from one tracker item show
 * the same item title with distinct purposes, the key opens the item, and a
 * card rename reaches every card-named chat and survives a restart.
 *
 * Fixture data is SYNTHETIC. Keys only exist on team-synced items, so the
 * keyed chats carry the fixture key `SYN-21`; the item itself is local.
 *
 * Screenshots go to e2e_test_output/card-session-identity/.
 */
import { test, expect, type ElectronApplication, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createTempWorkspace, launchElectronApp, waitForAppReady } from '../helpers';
import { switchToAgentMode } from '../utils/testHelpers';

const SHOTS = path.resolve(__dirname, '../../../../e2e_test_output/card-session-identity');
// The dev build writes an isolated main bundle to out2/; NIMBALYST_E2E_MAIN_PATH overrides.
const MAIN_PATH = process.env.NIMBALYST_E2E_MAIN_PATH ?? path.resolve(__dirname, '../../out2/main/index.js');
const CARD_TITLE = 'SYNTHETIC Show the card title and chat purpose consistently in every compact session view';
const RENAMED_TITLE = 'SYNTHETIC Card renamed after launch';
const KEY = 'SYN-21';

let app: ElectronApplication;
let page: Page;
let workspace: string;
let itemId: string;

test.setTimeout(180_000);

async function invoke(channel: string, ...args: unknown[]): Promise<any> {
  return page.evaluate(({ channel, args }) => (window as any).electronAPI.invoke(channel, ...args), { channel, args });
}

async function launch(preserve: boolean): Promise<void> {
  app = await launchElectronApp({ workspace, mainPath: MAIN_PATH, permissionMode: 'allow-all', preserveTestDatabase: preserve });
  page = await app.firstWindow();
  await waitForShell(preserve);
}

/** The app restores the last mode, which may hide the files sidebar; wait for the mode rail instead. */
async function waitForShell(restored: boolean): Promise<void> {
  if (!restored) {
    await waitForAppReady(page);
    return;
  }
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('[data-mode="agent"]', { timeout: 30_000 });
}

async function setWindowWidth(width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0];
    const [, h] = win.getSize();
    win.setSize(w, h);
  }, width);
  await page.waitForTimeout(400);
}

async function createCardSession(identity: Record<string, unknown>, numberRepeatedPurpose = false): Promise<{ id: string; title: string }> {
  const id = randomUUID();
  expect(await invoke('sessions:create', { session: { id, title: 'New Session', provider: 'claude-code' }, workspaceId: workspace }))
    .toMatchObject({ success: true });
  const result = await invoke('sessions:set-card-identity', id, { primaryTrackerId: itemId, ...identity }, { numberRepeatedPurpose });
  await invoke('tracker:link-session', { trackerId: itemId, sessionId: id });
  return { id, title: result.title };
}

test.beforeAll(async () => {
  await fs.mkdir(SHOTS, { recursive: true });
  workspace = await createTempWorkspace();
  await launch(false);
});

test.afterAll(async () => {
  await app?.close();
  if (workspace) await fs.rm(workspace, { recursive: true, force: true });
});

test('chats on one card read as one card with distinct purposes, and follow a rename across restart', async () => {
  itemId = `task_${randomUUID().slice(0, 8)}`;
  const created = await page.evaluate(({ itemId, workspace, title }) => (window as any).electronAPI.documentService.createTrackerItem({
    id: itemId, type: 'task', title, status: 'to-do', priority: 'medium', workspace,
  }), { itemId, workspace, title: CARD_TITLE });
  expect(created).toMatchObject({ success: true });

  // Real launch path: open the item, choose a purpose, Launch Session.
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent('nimbalyst:navigate-tracker-item', { detail: { itemId: id } })), itemId);
  const sessionsSection = page.locator('.tracker-sessions-section');
  await expect(sessionsSection).toBeVisible({ timeout: 15_000 });
  await page.getByTestId('tracker-launch-purpose-trigger').click();
  await page.getByTestId('tracker-launch-purpose-menu').getByRole('menuitemradio', { name: 'Independent review' }).click();
  await expect(page.getByTestId('tracker-launch-purpose-trigger')).toContainText('Independent review');
  await page.screenshot({ path: path.join(SHOTS, '01-launch-purpose-picker.png') });
  await sessionsSection.getByRole('button', { name: 'Launch Session' }).click();
  await expect(page.locator('.agent-mode')).toBeVisible({ timeout: 15_000 });

  // Keyed chats (fixture key), a repeated purpose, a custom name, a SYNTHETIC purpose.
  const implementation = await createCardSession({ issueKey: KEY, cardTitle: CARD_TITLE, purpose: 'Implementation' }, true);
  const implementation2 = await createCardSession({ issueKey: KEY, cardTitle: CARD_TITLE, purpose: 'Implementation' }, true);
  const review = await createCardSession({ issueKey: KEY, cardTitle: CARD_TITLE, purpose: 'Independent review' }, true);
  const synthetic = await createCardSession({ issueKey: KEY, cardTitle: CARD_TITLE, purpose: 'SYNTHETIC Codex check' }, true);
  const custom = await createCardSession({ issueKey: KEY, cardTitle: CARD_TITLE, purpose: 'Investigation' }, true);
  await invoke('sessions:update-title', custom.id, 'My own notes on naming');
  const general = randomUUID();
  await invoke('sessions:create', { session: { id: general, title: 'A general chat with a long descriptive title and no card at all', provider: 'claude-code' }, workspaceId: workspace });

  expect(implementation.title).toBe(`${KEY} · ${CARD_TITLE} — Implementation`);
  expect(implementation2.title).toBe(`${KEY} · ${CARD_TITLE} — Implementation 2`);
  expect(review.title).toBe(`${KEY} · ${CARD_TITLE} — Independent review 2`);
  expect(synthetic.title).toContain('SYNTHETIC Codex check');

  await page.reload();
  await waitForShell(true);
  await switchToAgentMode(page);

  const row = (label: string) => page.locator(`[aria-label^="Session: ${label},"]`).first();
  await expect(row(implementation.title)).toBeVisible();
  await expect(row(review.title)).toBeVisible();
  await expect(row(synthetic.title)).toBeVisible();
  await expect(row(`My own notes on naming (custom name; card ${KEY} · ${CARD_TITLE} — Investigation)`)).toBeVisible();
  // The UI launch has no key: the item is local and a key is never invented.
  await expect(row(`${CARD_TITLE} — Independent review`)).toBeVisible();
  // A general chat has no card key.
  await expect(row('A general chat with a long descriptive title and no card at all').getByTestId('session-identity-key')).toHaveCount(0);
  await expect(row(synthetic.title).getByTestId('session-identity-synthetic')).toBeVisible();

  await setWindowWidth(1400);
  await page.screenshot({ path: path.join(SHOTS, '02-session-list-wide.png') });
  await setWindowWidth(820);
  await page.waitForTimeout(1000);
  await page.screenshot({ path: path.join(SHOTS, '03-session-list-narrow.png') });
  await page.locator('.session-list-item-content').first().locator('xpath=ancestor::*[contains(@class,"overflow-y-auto")][1]').first()
    .screenshot({ path: path.join(SHOTS, '03b-session-list-rows.png') }).catch(() => {});
  // Narrow: key, purpose and SYNTHETIC are still rendered unclipped; the title absorbs the cut.
  for (const testId of ['session-identity-key', 'session-identity-synthetic']) {
    const part = row(synthetic.title).getByTestId(testId);
    const clipped = await part.evaluate((el) => el.scrollWidth > el.clientWidth);
    expect(clipped, `${testId} clipped`).toBe(false);
  }
  // Repeated purposes stay distinguishable: the number is not cut off.
  for (const [session, purpose] of [[implementation, 'Implementation'], [implementation2, 'Implementation 2'], [review, 'Independent review 2']] as const) {
    const part = row(session.title).getByTestId('session-identity-purpose');
    await expect(part).toHaveText(purpose);
    expect(await part.evaluate((el) => el.scrollWidth > el.clientWidth), `${purpose} clipped`).toBe(false);
  }

  // Header shows the identity for the selected chat.
  await row(review.title).click();
  const header = page.locator('.workstream-header-title').first();
  await expect(header).toContainText('Independent review 2');
  await expect(header.getByTestId('session-identity-key')).toHaveText(KEY);
  await page.screenshot({ path: path.join(SHOTS, '04-header.png') });

  // The key opens the card; the card lists every chat with its purpose.
  await header.getByTestId('session-identity-key').click();
  await expect(page.locator('.tracker-sessions-section')).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.tracker-linked-session')).toHaveCount(6);
  await setWindowWidth(1600);
  const section = page.locator('.tracker-sessions-section');
  await section.scrollIntoViewIfNeeded();
  await page.waitForTimeout(1000);
  await section.screenshot({ path: path.join(SHOTS, '05-card-linked-sessions.png') });
  await page.screenshot({ path: path.join(SHOTS, '05b-card-opened-from-key.png') });

  // Rename the card; card-named chats follow, the custom name stays.
  const renamed = await page.evaluate(({ itemId, title }) => (window as any).electronAPI.documentService.updateTrackerItem({
    itemId, updates: { title },
  }), { itemId, title: RENAMED_TITLE });
  expect(renamed).toMatchObject({ success: true });
  await expect.poll(async () => (await invoke('sessions:get', implementation.id)).session.title, { timeout: 10_000 })
    .toBe(`${KEY} · ${RENAMED_TITLE} — Implementation`);

  // Restart on the same profile.
  await app.close();
  await launch(true);
  await switchToAgentMode(page);
  await expect(row(`${KEY} · ${RENAMED_TITLE} — Implementation`)).toBeVisible();
  await expect(row(`${KEY} · ${RENAMED_TITLE} — Independent review 2`)).toBeVisible();
  await expect(row(`${RENAMED_TITLE} — Independent review`)).toBeVisible();
  // A custom-named chat is not retitled, so its stored card title is the one it had when renamed.
  await expect(row(`My own notes on naming (custom name; card ${KEY} · ${CARD_TITLE} — Investigation)`)).toBeVisible();
  await page.waitForTimeout(1000); // panels animate after restart; capture the settled layout
  await page.screenshot({ path: path.join(SHOTS, '06-after-rename-and-restart.png') });

  // Accessibility tree: the row's name carries the complete identity, SYNTHETIC included.
  const snapshot = await page.locator('body').ariaSnapshot();
  await fs.writeFile(path.join(SHOTS, '07-aria-snapshot.yaml'), snapshot);
  expect(snapshot).toContain(`${KEY} · ${RENAMED_TITLE} — SYNTHETIC Codex check`);
});
