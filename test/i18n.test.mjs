import assert from "node:assert/strict";
import { test } from "node:test";

import { LANGS, locale, normalizeLang, setLocale, stringKeys, stringsOf, t } from "../src/i18n.mjs";

test("每种语言都有每一条文案", () => {
  const keys = stringKeys();
  assert.ok(keys.length > 50, `文案条数 ${keys.length}`);
  for (const lang of LANGS) {
    const table = stringsOf(lang);
    for (const key of keys) {
      assert.ok(table[key], `${lang} 缺少：${key}`);
      if (lang !== "en") {
        assert.notEqual(table[key], key, `${lang} 没有翻译：${key}`);
      }
    }
  }
});

test("五种语言就是 Magpie 的那五种", () => {
  assert.deepEqual(LANGS, ["en", "zh", "zh-TW", "ja", "de"]);
});

test("Magpie 的 lang 值都折到插件支持的语言", () => {
  assert.equal(normalizeLang("zh"), "zh");
  assert.equal(normalizeLang("zh-CN"), "zh");
  assert.equal(normalizeLang("zh-TW"), "zh-TW");
  assert.equal(normalizeLang("zh-HK"), "zh-TW");
  assert.equal(normalizeLang("zh-Hant"), "zh-TW");
  assert.equal(normalizeLang("ja"), "ja");
  assert.equal(normalizeLang("ja-JP"), "ja");
  assert.equal(normalizeLang("de"), "de");
  assert.equal(normalizeLang("de-DE"), "de");
  // system 与不知道的语言退回英文，和 Magpie 窗口一致
  assert.equal(normalizeLang("system"), "en");
  assert.equal(normalizeLang(""), "en");
  assert.equal(normalizeLang("fr"), "en");
});

test("t() 按当前语言取文案，并填占位符", () => {
  setLocale("zh");
  assert.equal(locale(), "zh");
  assert.equal(t("Balance"), "余额");
  assert.equal(t("{left} left", { left: "¥3.20" }), "剩余 ¥3.20");

  setLocale("ja");
  assert.equal(t("Balance"), "残高");

  setLocale("de");
  assert.equal(t("Balance"), "Guthaben");

  setLocale("zh-TW");
  assert.equal(t("Balance"), "餘額");

  setLocale("en");
  assert.equal(t("Balance"), "Balance");
});

test("没有译文的句子原样返回，不返回 undefined", () => {
  setLocale("zh");
  assert.equal(t("一句谁都没写过的话"), "一句谁都没写过的话");
  assert.equal(t("一句谁都没写过的话 {x}", { x: 1 }), "一句谁都没写过的话 1");
});

test("中文与日文的译文真的是那种语言", () => {
  // 专有名词（Claude、GPT-5、New API、Responses……）本来就该原样保留，
  // 所以不逐词白名单，只看这条文案里有没有该语言的汉字/假名。
  // 德语和英语用同一套字母，认不出来，靠上面那条「每条都有译文」保证。
  for (const [lang, has] of [
    ["zh", /[一-鿿]{2,}/],
    ["zh-TW", /[一-鿿]{2,}/],
    ["ja", /[぀-ヿ一-鿿]{2,}/],
  ]) {
    const table = stringsOf(lang);
    for (const [en, value] of Object.entries(table)) {
      if (en === value) continue; // 上面那条已经保证每条都有译文
      assert.ok(has.test(value), `${lang} 的文案不像 ${lang}：${en} → ${value}`);
    }
  }
});
