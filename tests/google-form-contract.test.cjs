const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const rootDir = path.resolve(__dirname, '..');
const indexPath = path.join(rootDir, 'index.html');
const indexHtml = fs.readFileSync(indexPath, 'utf8');

let remoteFieldsPromise;

test('local RSVP fields match the live Google Form entry ids', async () => {
  const localFields = extractLocalFields(indexHtml);
  const remoteFields = await loadRemoteFields();

  assert.deepEqual([...localFields.keys()].sort(), [...remoteFields.keys()].sort());
});

test('local select values are valid Google Form choices or mapped to Other', async () => {
  const localFields = extractLocalFields(indexHtml);
  const remoteFields = await loadRemoteFields();

  for (const [name, field] of localFields) {
    if (field.type !== 'select') {
      continue;
    }

    const remoteField = remoteFields.get(name);
    assert.ok(remoteField, `${name} is not present in the live Google Form`);

    for (const option of field.options) {
      if (!option.value) {
        continue;
      }

      if (option.googleOtherResponse !== undefined) {
        assert.equal(
          remoteField.hasOther,
          true,
          `${name} uses "${option.value}" as Other, but the live Google Form has no Other option`,
        );
        continue;
      }

      assert.ok(
        remoteField.options.has(option.value),
        `${name} option "${option.value}" is not accepted by the live Google Form`,
      );
    }
  }
});

test('Google Forms Other options are encoded before submission', () => {
  const helpers = [
    extractFunctionSource(indexHtml, 'buildGoogleFormData'),
    extractFunctionSource(indexHtml, 'applyGoogleFormOtherOptions'),
    extractFunctionSource(indexHtml, 'appendGoogleFormMetadata'),
  ].join('\n\n');

  class FakeFormData {
    constructor(form) {
      this.items = form.initialEntries.map(([key, value]) => [String(key), String(value)]);
    }

    append(key, value) {
      this.items.push([String(key), String(value)]);
    }

    entries() {
      return this.items[Symbol.iterator]();
    }

    has(key) {
      return this.items.some(([itemKey]) => itemKey === key);
    }

    set(key, value) {
      const normalizedKey = String(key);
      const normalizedValue = String(value);
      const nextItems = this.items.filter(([itemKey]) => itemKey !== normalizedKey);
      nextItems.push([normalizedKey, normalizedValue]);
      this.items = nextItems;
    }

    [Symbol.iterator]() {
      return this.entries();
    }
  }

  const fakeForm = {
    initialEntries: [
      ['entry.1188616045', '5位以上'],
      ['entry.1339287923', "文豪的親友 William's friend"],
    ],
    querySelectorAll(selector) {
      assert.equal(selector, 'select[name]');
      return [
        {
          name: 'entry.1188616045',
          selectedOptions: [
            {
              dataset: {
                googleOtherResponse: '5位以上',
              },
            },
          ],
        },
        {
          name: 'entry.1339287923',
          selectedOptions: [
            {
              dataset: {},
            },
          ],
        },
      ];
    },
  };

  const context = {
    FormData: FakeFormData,
    URLSearchParams,
    fakeForm,
    result: null,
  };

  vm.runInNewContext(`${helpers}\nresult = buildGoogleFormData(fakeForm);`, context);
  const params = new Map(context.result.entries());

  assert.equal(params.get('entry.1188616045'), '__other_option__');
  assert.equal(params.get('entry.1188616045.other_option_response'), '5位以上');
  assert.equal(params.get('entry.1339287923'), "文豪的親友 William's friend");
  assert.equal(params.get('fvv'), '1');
  assert.equal(params.get('pageHistory'), '0');
});

async function loadRemoteFields() {
  if (!remoteFieldsPromise) {
    remoteFieldsPromise = (async () => {
      const formResponseUrl = extractGoogleFormResponseUrl(indexHtml);
      const viewFormUrl = formResponseUrl.replace('/formResponse', '/viewform');
      const response = await fetch(viewFormUrl);

      assert.equal(response.ok, true, `Could not fetch ${viewFormUrl}`);

      const html = await response.text();
      const loadData = extractFbPublicLoadData(html);
      return extractRemoteFields(loadData);
    })();
  }

  return remoteFieldsPromise;
}

function extractGoogleFormResponseUrl(html) {
  const match = html.match(/https:\/\/docs\.google\.com\/forms\/d\/e\/[^"']+\/formResponse/);
  assert.ok(match, 'Google Form formResponse URL was not found in index.html');
  return match[0];
}

function extractFbPublicLoadData(html) {
  const marker = 'var FB_PUBLIC_LOAD_DATA_ = ';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'FB_PUBLIC_LOAD_DATA_ was not found in the Google Form HTML');

  const dataStart = start + marker.length;
  const dataEnd = html.indexOf(';</script>', dataStart);
  assert.notEqual(dataEnd, -1, 'Could not find the end of FB_PUBLIC_LOAD_DATA_');

  return JSON.parse(html.slice(dataStart, dataEnd));
}

function extractRemoteFields(loadData) {
  const questions = loadData?.[1]?.[1];
  assert.ok(Array.isArray(questions), 'Google Form question metadata was not found');

  const fields = new Map();

  for (const question of questions) {
    const entries = question?.[4];
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      const id = entry?.[0];
      if (typeof id !== 'number') {
        continue;
      }

      const options = new Set();
      let hasOther = false;

      if (Array.isArray(entry[1])) {
        for (const option of entry[1]) {
          const value = option?.[0];
          const isOther = option?.[4] === 1;

          if (isOther) {
            hasOther = true;
          } else if (typeof value === 'string') {
            options.add(value);
          }
        }
      }

      fields.set(`entry.${id}`, {
        options,
        hasOther,
      });
    }
  }

  return fields;
}

function extractLocalFields(html) {
  const formHtml = extractRsvpFormHtml(html);
  const fields = new Map();
  const selectRegex = /<select\b([^>]*)>([\s\S]*?)<\/select>/gi;
  let selectMatch;

  while ((selectMatch = selectRegex.exec(formHtml))) {
    const attrs = parseAttributes(selectMatch[1]);
    if (!attrs.name?.startsWith('entry.')) {
      continue;
    }

    fields.set(attrs.name, {
      type: 'select',
      options: extractOptions(selectMatch[2]),
    });
  }

  const fieldRegex = /<(input|textarea)\b([^>]*)>/gi;
  let fieldMatch;

  while ((fieldMatch = fieldRegex.exec(formHtml))) {
    const attrs = parseAttributes(fieldMatch[2]);
    if (!attrs.name?.startsWith('entry.') || fields.has(attrs.name)) {
      continue;
    }

    fields.set(attrs.name, {
      type: fieldMatch[1].toLowerCase(),
      options: [],
    });
  }

  return fields;
}

function extractRsvpFormHtml(html) {
  const match = html.match(/<form\b[^>]*id="rsvp-form"[\s\S]*?<\/form>/i);
  assert.ok(match, 'RSVP form was not found in index.html');
  return match[0];
}

function extractOptions(selectHtml) {
  const options = [];
  const optionRegex = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let match;

  while ((match = optionRegex.exec(selectHtml))) {
    const attrs = parseAttributes(match[1]);
    const label = decodeHtml(stripTags(match[2])).trim();
    const value = attrs.value ?? label;

    options.push({
      value,
      label,
      googleOtherResponse: attrs['data-google-other-response'],
    });
  }

  return options;
}

function parseAttributes(source) {
  const attrs = {};
  const attrRegex = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;

  while ((match = attrRegex.exec(source))) {
    const [, name, doubleQuoted, singleQuoted, unquoted] = match;
    const value = doubleQuoted ?? singleQuoted ?? unquoted ?? '';
    attrs[name] = decodeHtml(value);
  }

  return attrs;
}

function stripTags(value) {
  return value.replace(/<[^>]+>/g, '');
}

function decodeHtml(value) {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function extractFunctionSource(html, functionName) {
  const marker = `function ${functionName}`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `${functionName} was not found in index.html`);

  const bodyStart = html.indexOf('{', start);
  assert.notEqual(bodyStart, -1, `${functionName} has no function body`);

  let depth = 0;
  let quote = null;
  let escaped = false;

  for (let index = bodyStart; index < html.length; index += 1) {
    const char = html[index];

    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;

      if (depth === 0) {
        return html.slice(start, index + 1);
      }
    }
  }

  throw new Error(`Could not extract ${functionName}`);
}
