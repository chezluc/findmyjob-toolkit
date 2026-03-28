#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE, readJson, writeJson } from './agent-utils.mjs';

const args = process.argv.slice(2);
function getArg(name, fallback = '') {
  const prefix = `--${name}=`;
  const hit = args.find((item) => item.startsWith(prefix));
  if (hit) return hit.slice(prefix.length);
  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];
  return fallback;
}

function splitName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName: parts.slice(1).join(' '),
  };
}

function detectCountryCode(location = '') {
  if (/brazil/i.test(location)) return '+55';
  if (/united states|usa|us/i.test(location)) return '+1';
  return '';
}

function parsePublicLinks(resumeText = '') {
  const websiteMatch = resumeText.match(/\b(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,}(?:\/[^\s|]+)?)\b/i);
  const linkedinMatch = resumeText.match(/\b(?:https?:\/\/)?(linkedin\.com\/[^\s|]+)\b/i);

  const normalizeUrl = (value) => {
    if (!value) return '';
    return /^https?:\/\//i.test(value) ? value : `https://${value}`;
  };

  return {
    website: websiteMatch ? normalizeUrl(websiteMatch[1]) : '',
    linkedin: linkedinMatch ? normalizeUrl(linkedinMatch[1]) : '',
  };
}

function extractCompensationHint(descriptionText = '') {
  const match = String(descriptionText || '').match(/\$ ?(\d{2,3})(?:[–-]|to)\$? ?(\d{2,3})\/hour/i);
  if (!match) return '';
  return `$${match[1]}-$${match[2]}/hour`;
}

function buildEvidenceThemes(evidenceResults = []) {
  return (evidenceResults || [])
    .slice(0, 3)
    .map((item) => {
      const claims = Array.isArray(item.claims_supported) ? item.claims_supported.filter(Boolean) : [];
      if (claims.length > 0) return claims[0];
      return item.material_title || '';
    })
    .filter(Boolean);
}

function buildGenericCustomAnswer(label, context) {
  const { company, roleTitle, evidenceThemes } = context;
  const themes = evidenceThemes.slice(0, 3);
  const themeSentence = themes.length > 0
    ? themes.join('; ').replace(/; ([^;]+)$/, ', and $1')
    : 'production design, design systems maintenance, and workflow automation';

  if (/why|interested|want|appeal/i.test(label)) {
    return `I’m interested in the ${roleTitle || 'role'} at ${company || 'your team'} because it brings together the kind of production design work I do best: precision execution, scalable systems, and collaboration across creative and technical partners. My background includes ${themeSentence}, which maps well to the way this role is described.`;
  }

  if (/fit|qualified|experience|background|relevant/i.test(label)) {
    return `My background is a strong match for the ${roleTitle || 'role'} because I’ve repeatedly worked at the intersection of production design, systems maintenance, and delivery quality. The most relevant parts of my experience include ${themeSentence}.`;
  }

  return `The strongest reason I’m a fit for the ${roleTitle || 'role'} at ${company || 'your team'} is that my experience consistently combines production execution, system organization, and workflow improvement. The most relevant evidence from my background includes ${themeSentence}.`;
}

function buildKnownFieldPlans(fields, context) {
  const { firstName, lastName, website, linkedin, phoneCountry, resumeOutputPath } = context;
  const plans = [];

  for (const field of fields || []) {
    const label = field.label;
    let answer = '';
    let status = 'ready';
    let notes = '';

    if (label === 'First Name') answer = firstName;
    else if (label === 'Last Name') answer = lastName;
    else if (label === 'Phone Country') answer = phoneCountry;
    else if (label === 'Resume/CV') answer = resumeOutputPath || '';
    else if (label === 'Portfolio/Website Link') answer = website;
    else if (label === 'LinkedIn Profile') answer = linkedin;
    else if (label === 'Email' || label === 'Phone') {
      status = 'needs_user';
      notes = 'No canonical contact value stored yet.';
    } else if (label === 'Cover Letter') {
      status = 'optional';
      notes = 'Can be generated from the tailored outreach/email draft if needed.';
    }

    if (!answer && status === 'ready') {
      status = field.required ? 'needs_user' : 'optional';
      if (!notes) notes = 'No canonical value available yet.';
    }

    plans.push({
      label,
      type: field.type,
      required: field.required,
      status,
      answer,
      notes,
    });
  }

  return plans;
}

function buildQuestionPlans(questions, context) {
  const { company, roleTitle, compensationHint, evidenceThemes } = context;
  return (questions || []).map((question) => {
    const label = question.label;
    let status = 'custom_ready';
    let answer = '';
    let notes = '';
    let options = [];

    if (/compensation expectations/i.test(label)) {
      status = 'custom_ready';
      answer = compensationHint
        ? `I’m targeting a range aligned with the posted contract budget (${compensationHint}), and I’m open to discussing the final rate based on scope, hours, and deliverables.`
        : 'I’m open to discussing compensation based on the scope, expected hours, and overall contract structure.';
      notes = 'Review before submitting.';
    } else if (/best live events? you\'ve attended/i.test(label)) {
      status = 'needs_user_memory';
      notes = `This needs a real personal event. Once provided, shape it around why that experience maps to ${company || 'the company'} and the ${roleTitle || 'role'}.`;
    } else if (/eligible to work in the united states/i.test(label)) {
      status = 'needs_user_choice';
      options = ['Yes', 'No'];
      notes = 'Legal/work authorization answer should not be guessed.';
    } else if (/visa sponsorship/i.test(label)) {
      status = 'needs_user_choice';
      options = ['Yes', 'No'];
      notes = 'Legal/sponsorship answer should not be guessed.';
    } else {
      status = 'custom_ready';
      answer = buildGenericCustomAnswer(label, { company, roleTitle, evidenceThemes });
      notes = `Generated from the posting context and top retrieved evidence for ${company || 'the company'}.`;
    }

    return {
      label,
      required: question.required,
      type: question.type,
      status,
      answer,
      notes,
      options,
    };
  });
}

const runDir = getArg('runDir');
const postingPath = getArg('posting');
const evidencePath = getArg('evidence');
const applicationPath = getArg('application');
const resumeOutputPath = getArg('resumeOutputPath');

if (!runDir || !postingPath || !applicationPath) {
  console.error('Usage: node scripts/plan-application-answers.mjs --runDir=/path --posting=/path/posting.json --application=/path/application-structure.json [--evidence=/path/evidence.json] [--resumeOutputPath=/path/resume.txt]');
  process.exit(1);
}

const profile = await readJson(path.join(WORKSPACE, 'resume', 'profile.json'));
const posting = await readJson(postingPath);
const application = await readJson(applicationPath);
const evidence = evidencePath ? await readJson(evidencePath) : { results: [] };
const canonicalResumePath = profile.canonical_resume_sources?.find((file) => file.endsWith('.txt'));
const canonicalResumeText = canonicalResumePath ? await fs.readFile(canonicalResumePath, 'utf8') : '';

const { firstName, lastName } = splitName(profile.person?.name || '');
const { website, linkedin } = parsePublicLinks(canonicalResumeText);
const phoneCountry = detectCountryCode(profile.person?.location || '');
const compensationHint = extractCompensationHint(application.descriptionText || '');
const evidenceThemes = buildEvidenceThemes(evidence.results || []);

const knownFieldPlans = buildKnownFieldPlans(application.applicationForm?.knownFields || [], {
  firstName,
  lastName,
  website,
  linkedin,
  phoneCountry,
  resumeOutputPath,
});

const questionPlans = buildQuestionPlans(application.applicationForm?.customQuestions || [], {
  company: posting.company,
  roleTitle: posting.roleTitle,
  compensationHint,
  evidenceThemes,
});

const answerPlan = {
  createdAt: new Date().toISOString(),
  company: posting.company,
  roleTitle: posting.roleTitle,
  postingUrl: posting.postingUrl,
  candidate: {
    name: profile.person?.name || '',
    location: profile.person?.location || '',
    openToRelocation: profile.person?.open_to_relocation ?? null,
    website,
    linkedin,
  },
  evidenceHighlights: (evidence.results || []).slice(0, 3).map((item) => ({
    materialTitle: item.material_title,
    claimsSupported: item.claims_supported || [],
    snippet: item.snippet,
    sourcePath: item.source_path,
  })),
  fields: knownFieldPlans,
  questions: questionPlans,
  demographics: {
    status: 'skip_or_user_choice',
    questions: application.applicationForm?.demographicQuestions || [],
  },
};

const outputPath = path.join(runDir, 'application-answer-plan.json');
await writeJson(outputPath, answerPlan);

console.log(JSON.stringify({ outputPath, readyFieldCount: knownFieldPlans.filter((item) => item.status === 'ready').length, customQuestionCount: questionPlans.filter((item) => item.status === 'custom_ready').length, unresolvedQuestionCount: questionPlans.filter((item) => item.status !== 'custom_ready').length }, null, 2));
