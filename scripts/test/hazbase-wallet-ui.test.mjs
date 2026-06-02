import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { t } from "../../web/i18n.js";

const appSource = readFileSync(new URL("../../web/app.js", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../../web/app.css", import.meta.url), "utf8");

function functionBody(name) {
  const start = appSource.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `${name} should exist`);
  const nextFunction = appSource.indexOf("\nfunction ", start + 1);
  return appSource.slice(start, nextFunction === -1 ? undefined : nextFunction);
}

test("hazbase wallet auth actions show pending feedback and have bounded requests", () => {
  assert.match(appSource, /const HAZBASE_ACTION_TIMEOUT_MS = 30_000;/);
  assert.match(appSource, /hazbasePendingAction: ""/);
  assert.match(appSource, /state\.hazbasePendingAction = hazbaseActionPendingKey\(action, actionNetwork\);/);
  assert.match(appSource, /button\.classList\.add\("is-loading"\);/);
  assert.match(
    appSource,
    /apiPost\("\/api\/hazbase\/verify-otp", \{ email, code \}, \{ timeoutMs: HAZBASE_ACTION_TIMEOUT_MS \}\);/
  );
  assert.match(appSource, /await fetchHazbaseStatus\(\{ timeoutMs: HAZBASE_ACTION_TIMEOUT_MS \}\);/);
});

test("hazbase upstream error codes are localized before display", () => {
  assert.equal(
    t("ja", "error.unsupportedChain"),
    "このネットワークのウォレット発行はまだサポートされていません。対応済みのネットワークを選んでください。"
  );
  assert.equal(
    t("ja", "error.hazbaseLiquidAddressInvalid"),
    "このネットワーク用の有効な Liquid payout アドレスを入力してください。"
  );
  assert.match(functionBody("readError"), /firstApiErrorKey\(payload\)/);
  assert.match(functionBody("firstApiErrorKey"), /payload\.code/);
  assert.match(functionBody("firstApiErrorKey"), /payload\.errorCode/);
  assert.match(functionBody("extractEmbeddedApiErrorPayload"), /JSON\.parse/);
  assert.match(functionBody("normalizeApiErrorKey"), /\.replace\(\/_\/g, "-"\)/);
  assert.match(functionBody("localizeApiError"), /"unsupported-chain": "error\.unsupportedChain"/);
  assert.match(functionBody("localizeApiError"), /"invalid-liquid-address": "error\.hazbaseLiquidAddressInvalid"/);
});

test("hazbase wallet treats server-side passkeys as already registered", () => {
  assert.equal(t("en", "settings.hazbase.passkey.ready"), "Registered for this account");
  assert.equal(t("ja", "settings.hazbase.passkey.ready"), "このアカウントで登録済み");
  assert.equal(
    t("ja", "error.hazbasePasskeyAlreadyRegistered"),
    "このアカウントには既にパスキーが登録されています。既存のパスキーで続行してください。"
  );
  assert.match(functionBody("renderWalletInventoryCapabilityCard"), /hazbase\.passkeyRegistered/);
  assert.match(functionBody("deriveHazbaseWalletFlow"), /hazbase\.passkeyRegistered/);
  assert.match(appSource, /InvalidStateError/);
  assert.match(appSource, /error\.hazbasePasskeyAlreadyRegistered/);
});

test("wallet inventory is localized and backs out to wallet settings", () => {
  assert.equal(t("ja", "settings.wallet.agent.copy"), "有料ファイル共有で支払いを受け取るウォレットを選びます。mainnet は正式リリースまで除外されます。");
  assert.equal(t("ja", "settings.wallet.betaNotice"), "ウォレット機能はベータテスト中です。Testnet を安全な既定値にし、mainnet は正式リリース時にご利用いただけます。");
  assert.equal(t("ja", "settings.wallet.inventory.title"), "ウォレット管理");
  assert.equal(t("ja", "settings.wallet.inventory.issueTitle"), "ウォレット発行・登録");
  assert.equal(t("en", "settings.wallet.inventory.title"), "Wallet Inventory");
  assert.match(functionBody("parentSettingsSubpage"), /page === "walletInventoryBase" \|\| page === "walletInventoryLiquid" \|\| page === "walletInventoryPolygon"/);
  assert.match(functionBody("parentSettingsSubpage"), /return "walletInventory";/);
  assert.match(functionBody("parentSettingsSubpage"), /return page === "walletInventory" \? "wallet" : "";/);
  assert.match(appSource, /const openingFromRoot = !state\.settingsSubpage;/);
});

test("wallet inventory does not repeat the wallet beta notice", () => {
  assert.match(functionBody("renderSettingsWalletPage"), /renderHazbaseWalletBetaNotice\(\)/);
  assert.doesNotMatch(functionBody("renderSettingsWalletInventoryPage"), /renderHazbaseWalletBetaNotice\(\)/);
});

test("wallet inventory groups issuance by chain before network environment", () => {
  const inventoryBody = functionBody("renderSettingsWalletInventoryPage");
  assert.match(inventoryBody, /settings\.wallet\.inventory\.issueTitle/);
  assert.match(inventoryBody, /paymentCapabilityChainDefinitions\(\)/);
  assert.doesNotMatch(inventoryBody, /\["base-sepolia", "liquidtestnet"\]/);
  assert.match(functionBody("renderSettingsWalletChainPage"), /renderWalletInventoryCapabilityCard\(hazbase, network\)/);
  assert.match(appSource, /case "walletInventoryBase":[\s\S]*?renderSettingsWalletChainPage\(context, "base"\)/);
  assert.match(appSource, /case "walletInventoryLiquid":[\s\S]*?renderSettingsWalletChainPage\(context, "liquid"\)/);
  assert.match(appSource, /case "walletInventoryPolygon":[\s\S]*?renderSettingsWalletChainPage\(context, "polygon"\)/);
});

test("wallet inventory chain values count configured networks instead of assets", () => {
  assert.match(functionBody("renderSettingsWalletPage"), /const configuredNetworkCount = configuredPaymentCapabilityNetworkCount\(hazbase\)/);
  assert.match(functionBody("renderSettingsWalletPage"), /settings\.wallet\.inventory\.navValue", \{ count: configuredNetworkCount \}/);
  assert.match(functionBody("renderSettingsWalletInventoryPage"), /configuredPaymentCapabilityNetworkCount\(hazbase, definition\.networks\)/);
  assert.match(functionBody("configuredPaymentCapabilityNetworkCount"), /const shouldCountAllNetworks = !Array\.isArray\(networks\)/);
  assert.match(functionBody("configuredPaymentCapabilityNetworkCount"), /const configuredNetworks = new Set\(\)/);
  assert.match(functionBody("configuredPaymentCapabilityNetworkCount"), /configuredNetworks\.add\(entry\.network\)/);
  assert.match(functionBody("paymentCapabilityChainValue"), /count: configuredPaymentCapabilityNetworkCount\(hazbase, countedNetworks\)/);
});

test("account actions live on wallet inventory instead of wallet defaults", () => {
  assert.doesNotMatch(functionBody("renderSettingsWalletPage"), /settings\.wallet\.advanced\.title/);
  assert.match(functionBody("renderHazbaseAccountActions"), /settings\.wallet\.advanced\.title/);
  assert.match(functionBody("renderHazbaseAccountActions"), /data-hazbase-action="refresh-session"/);
  assert.match(functionBody("renderHazbaseAccountActions"), /data-hazbase-action="logout"/);
  assert.match(functionBody("renderSettingsWalletInventoryPage"), /renderHazbaseAccountActions\(hazbase\)/);
});

test("hazbase notices and action failures render as toast instead of wallet top notice", () => {
  assert.match(appSource, /toast: null/);
  assert.match(appSource, /function showToast\(message/);
  assert.match(appSource, /function renderToastLayer\(\)/);
  assert.match(functionBody("renderShell"), /renderToastLayer\(\)/);
  assert.match(functionBody("showToast"), /normalizedTone === "error" \? 5600 : 3800/);
  assert.match(functionBody("renderToastLayer"), /tone === "error" \? "alert" : "status"/);
  assert.match(appSource, /showToast\(L\("settings\.hazbase\.notice\.walletBootstrapped"/);
  assert.match(appSource, /showToast\(L\("settings\.hazbase\.notice\.agentDefaultsSaved"\)\)/);
  assert.match(appSource, /showToast\(message, \{ tone: "error" \}\)/);
  assert.doesNotMatch(functionBody("renderHazbaseWalletMessages"), /hazbaseNotice|hazbaseError/);
});

test("hazbase form errors render inline near their inputs", () => {
  assert.match(appSource, /hazbaseFormErrors: \{ email: "", otp: "", liquid: \{\} \}/);
  assert.match(functionBody("renderHazbaseSignInForm"), /hazbaseFormError\("email"\)/);
  assert.match(functionBody("renderHazbaseSignInForm"), /hazbase-email-error/);
  assert.match(functionBody("renderHazbaseSignInForm"), /wallet-step-card__field-error/);
  assert.match(functionBody("renderLiquidCapabilityForm"), /hazbaseFormError\("liquid", network\)/);
  assert.match(functionBody("renderLiquidCapabilityForm"), /hazbase-liquid-error-\$\{network\}/);
  assert.match(functionBody("applyHazbaseInlineError"), /invalid-liquid-address/);
  assert.match(functionBody("clearRenderedHazbaseInputError"), /wallet-step-card__field-input--error/);
});

test("agent payment default checkboxes survive settings re-renders before save", () => {
  assert.match(appSource, /hazbaseAgentPaymentDefaultsDraft: null/);
  assert.match(functionBody("renderSettingsWalletPage"), /settings\.wallet\.agent\.unsaved/);
  assert.match(appSource, /document\.querySelectorAll\("\[data-agent-payment-default\]"\)/);
  assert.match(appSource, /state\.hazbaseAgentPaymentDefaultsDraft = \{\s*mode: "custom",\s*accepts: selectedAgentPaymentDefaultRefs\(\),\s*\};/);
  assert.match(appSource, /state\.hazbaseAgentPaymentDefaultsDraft\?\.mode === "custom"/);
  assert.match(appSource, /state\.hazbaseAgentPaymentDefaultsDraft = null;/);
});

test("agent payment default summary stays on saved values while checkboxes use draft", () => {
  assert.equal(t("ja", "settings.wallet.agent.unsaved"), "未保存の変更があります。保存すると受け取り先に反映されます。");
  assert.equal(t("ja", "settings.wallet.agent.modalTitle"), "有効な受け取り先");
  assert.match(functionBody("activeAgentPaymentDefaults"), /includeDraft = false/);
  assert.match(functionBody("effectiveAgentPaymentDefaults"), /includeDraft = false/);
  assert.match(functionBody("isAgentPaymentDefaultEnabled"), /effectiveAgentPaymentDefaults\(hazbase, \{ includeDraft: true \}\)/);
  assert.doesNotMatch(functionBody("renderSettingsWalletPage"), /hazbaseWithAgentPaymentDefaultsDraft/);
  assert.match(functionBody("renderSettingsWalletPage"), /renderAgentPaymentDefaultsSummary\(hazbase, effectiveDefaults\)/);
  assert.match(functionBody("renderSettingsWalletPage"), /stacked: defaultsSummary\.stacked/);
  assert.match(functionBody("agentPaymentDefaultDisplayItems"), /paymentCapabilityDisplayLabel\(capability\)/);
  assert.match(functionBody("renderAgentPaymentDefaultsSummary"), /wallet-agent-default-pill/);
  assert.match(functionBody("renderAgentPaymentDefaultsSummary"), /wallet-agent-default-more/);
  assert.match(functionBody("renderAgentPaymentDefaultsSummary"), /data-open-agent-payment-defaults/);
  assert.match(functionBody("renderAgentPaymentDefaultsModal"), /settings\.wallet\.agent\.modalTitle/);
  assert.match(functionBody("renderAgentPaymentDefaultsModal"), /wallet-agent-defaults-modal-list/);
  assert.match(functionBody("bindSharedUi"), /data-open-agent-payment-defaults/);
  assert.match(functionBody("bindSharedUi"), /data-close-agent-payment-defaults/);
  assert.match(appCss, /\.wallet-agent-defaults-summary-button/);
  assert.match(appCss, /\.wallet-agent-default-more/);
  assert.match(appCss, /\.wallet-agent-defaults-modal-list/);
});

test("mainnet payment capabilities stay coming soon and are excluded from agent defaults", () => {
  assert.equal(t("ja", "settings.wallet.agent.useAllConfigured"), "すべての受け取り先を有効にする");
  assert.equal(t("ja", "settings.wallet.mainnet.comingSoonDetail"), "mainnet は正式リリース時に利用できます。");
  assert.equal(t("ja", "settings.wallet.chain.polygon.title"), "Polygon");
  assert.match(functionBody("paymentCapabilityDefinitions"), /base:[\s\S]*releaseStatus: "comingSoon"/);
  assert.match(functionBody("paymentCapabilityDefinitions"), /polygon:[\s\S]*releaseStatus: "comingSoon"/);
  assert.match(functionBody("paymentCapabilityDefinitions"), /liquidv1:[\s\S]*releaseStatus: "comingSoon"/);
  assert.match(functionBody("agentEligiblePaymentCapabilities"), /isPaymentCapabilityAvailable\(entry\.network\)/);
  assert.match(functionBody("normalizeAgentPaymentDefaultRefs"), /!isPaymentCapabilityAvailable\(ref\.network\)/);
  assert.match(functionBody("renderWalletInventoryCapabilityCard"), /status: !available \? "comingSoon"/);
  assert.match(functionBody("renderWalletInventoryCapabilityCard"), /form: available && !configured/);
  assert.match(functionBody("localizeApiError"), /"payment-network-coming-soon": "error\.paymentNetworkComingSoon"/);
});
