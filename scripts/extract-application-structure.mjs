#!/usr/bin/env node

import path from 'node:path';
import { readJson, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);
function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function detectVendor(postingUrl = '', pageTitle = '') {
  const url = String(postingUrl || '').toLowerCase();
  const title = String(pageTitle || '').toLowerCase();
  if (url.includes('greenhouse.io') || title.includes('mygreenhouse') || title.includes('greenhouse')) return 'greenhouse';
  if (url.includes('lever.co')) return 'lever';
  if (url.includes('myworkdayjobs.com') || url.includes('workday')) return 'workday';
  if (url.includes('ashbyhq.com')) return 'ashby';
  if (url.includes('smartrecruiters.com')) return 'smartrecruiters';
  return 'unknown';
}

function compactWhitespace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function splitSections(postingText = '') {
  const text = String(postingText || '');
  const applyIndex = text.indexOf('Apply for this job');
  const demographicIndex = text.indexOf('U.S. Standard Demographic Questions');
  const submitIndex = text.indexOf('Submit application');

  const descriptionText = compactWhitespace(
    applyIndex >= 0 ? text.slice(0, applyIndex) : text,
  );

  let applicationText = '';
  if (applyIndex >= 0) {
    const endIndex = demographicIndex >= 0
      ? demographicIndex
      : submitIndex >= 0
        ? submitIndex
        : text.length;
    applicationText = compactWhitespace(text.slice(applyIndex, endIndex));
  }

  const demographicsText = compactWhitespace(
    demographicIndex >= 0 ? text.slice(demographicIndex) : '',
  );

  return { descriptionText, applicationText, demographicsText };
}

function extractKnownFields(text = '') {
  const knownFields = [
    { label: 'First Name', required: true, type: 'text' },
    { label: 'Last Name', required: true, type: 'text' },
    { label: 'Email', required: true, type: 'email' },
    { label: 'Phone Country', required: true, type: 'select' },
    { label: 'Phone', required: true, type: 'tel' },
    { label: 'Resume/CV', required: true, type: 'file' },
    { label: 'Cover Letter', required: false, type: 'file' },
    { label: 'Portfolio/Website Link', required: false, type: 'url' },
    { label: 'LinkedIn Profile', required: false, type: 'url' },
  ];
  return knownFields.filter((field) => text.includes(field.label));
}

function extractCustomQuestions(text = '') {
  const questionPatterns = [
    /What's one of the best live events you've attended\?/gi,
    /What are your compensation expectations\?\s*\*/gi,
    /Are you currently eligible to work in the United States\?\s*\*/gi,
    /Do you now, or in the future, require visa sponsorship to continue working in the United States\?\s*\*/gi,
  ];

  return questionPatterns
    .map((pattern) => {
      const match = text.match(pattern);
      if (!match) return null;
      const raw = compactWhitespace(match[0]);
      return {
        label: raw.replace(/\s*\*$/, ''),
        required: /\*$/.test(raw),
        type: raw.includes('Select') ? 'select' : raw.endsWith('?') ? 'question' : 'text',
      };
    })
    .filter(Boolean);
}

function extractUploadOptions(text = '') {
  const options = [];
  if (text.includes('Attach Dropbox')) options.push('Dropbox');
  if (text.includes('Google Drive')) options.push('Google Drive');
  if (text.includes('Enter manually')) options.push('Enter manually');
  if (text.includes('Attach')) options.unshift('Attach');
  return Array.from(new Set(options));
}

function extractDemographicQuestions(text = '') {
  if (!text) return [];
  const labels = [
    'How would you describe your gender identity? (mark all that apply)',
    'How would you describe your racial/ethnic background? (mark all that apply)',
    'How would you describe your sexual orientation? (mark all that apply)',
    'Do you identify as transgender? (select one)',
    'Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, or other) that substantially limits one or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning? (select one)',
    'Are you a veteran or active member of the United States Armed Forces? (select one)',
  ];
  return labels.filter((label) => text.includes(label));
}

const runDir = getArg('runDir');
const postingPath = getArg('posting');

if (!runDir || !postingPath) {
  console.error('Usage: node scripts/extract-application-structure.mjs --runDir=/path --posting=/path/posting.json');
  process.exit(1);
}

const posting = await readJson(postingPath);
const { descriptionText, applicationText, demographicsText } = splitSections(posting.postingText || '');
const vendor = detectVendor(posting.postingUrl, posting.pageTitle);
const knownFields = extractKnownFields(applicationText);
const customQuestions = extractCustomQuestions(applicationText);
const demographicQuestions = extractDemographicQuestions(demographicsText);
const uploadOptions = extractUploadOptions(applicationText);

const structure = {
  extractedAt: new Date().toISOString(),
  vendor,
  company: posting.company,
  roleTitle: posting.roleTitle,
  postingUrl: posting.postingUrl,
  pageTitle: posting.pageTitle,
  descriptionText,
  applicationForm: {
    hasForm: applicationText.includes('Apply for this job'),
    uploadOptions,
    knownFields,
    customQuestions,
    demographicQuestions,
  },
};

const outputPath = path.join(runDir, 'application-structure.json');
await writeJson(outputPath, structure);

console.log(JSON.stringify({ outputPath, vendor, knownFieldCount: knownFields.length, customQuestionCount: customQuestions.length }, null, 2));
