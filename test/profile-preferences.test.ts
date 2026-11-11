import test from 'node:test';
import assert from 'node:assert/strict';
import { readProfilePreferenceList } from '../src/application/profile-preferences.ts';

test('profile preference form preserves separately-added countries and custom interests', () => {
  const form = new FormData();
  form.append('targetCountry', 'Japan');
  form.append('targetCountry', 'Holy See');
  form.append('researchInterest', 'privacy-preserving machine learning');
  form.append('researchInterest', 'reliable distributed systems');
  assert.deepEqual(readProfilePreferenceList(form, 'targetCountry', 'countries'), ['Japan', 'Holy See']);
  assert.deepEqual(readProfilePreferenceList(form, 'researchInterest', 'researchInterests'), ['privacy-preserving machine learning', 'reliable distributed systems']);
});

test('profile preference parsing keeps compatibility with the previous comma-separated controls', () => {
  const form = new FormData();
  form.set('countries', 'Japan, Holy See');
  form.set('researchInterests', 'privacy, distributed systems');
  assert.deepEqual(readProfilePreferenceList(form, 'targetCountry', 'countries'), ['Japan', 'Holy See']);
  assert.deepEqual(readProfilePreferenceList(form, 'researchInterest', 'researchInterests'), ['privacy', 'distributed systems']);
});

test('repeated research-interest controls preserve commas inside complete topic entries', () => {
  const form = new FormData();
  for (const interest of [
    'Cybersecurity, privacy, and network security',
    'AI and machine learning',
    'Software engineering, cloud, and distributed systems',
    'Robotics and autonomous systems, including intelligent robotics and robot perception',
    'Database systems and data-intensive applications',
    'Mobile computing and human-computer interaction, including accessibility',
  ]) form.append('researchInterest', interest);

  assert.deepEqual(readProfilePreferenceList(form, 'researchInterest', 'researchInterests'), [
    'Cybersecurity, privacy, and network security',
    'AI and machine learning',
    'Software engineering, cloud, and distributed systems',
    'Robotics and autonomous systems, including intelligent robotics and robot perception',
    'Database systems and data-intensive applications',
    'Mobile computing and human-computer interaction, including accessibility',
  ]);
});

test('preference form rejects removing the final saved value', () => {
  const form = new FormData();
  assert.throws(() => readProfilePreferenceList(form, 'targetCountry', 'countries'), /At least one/);
});
