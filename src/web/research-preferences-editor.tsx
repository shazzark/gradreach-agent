'use client';

import { useState } from 'react';
import { OFFICIAL_HOSTS_BY_REGION } from '../config/official-host-allowlist.ts';
import { ui } from './ui-classes.ts';

function PreferenceList({ label, name, values, setValues, placeholder }: {
  label: string;
  name: 'targetCountry' | 'researchInterest';
  values: string[];
  setValues: (values: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState('');
  const add = () => {
    const value = draft.trim();
    if (!value || values.some((item) => item.toLocaleLowerCase() === value.toLocaleLowerCase())) return;
    setValues([...values, value]);
    setDraft('');
  };
  return <fieldset className={ui.fieldset}>
    <legend className="px-1 text-sm font-semibold">{label}</legend>
    {values.map((value, index) => {
      const hosts = name === 'targetCountry' ? OFFICIAL_HOSTS_BY_REGION[value as keyof typeof OFFICIAL_HOSTS_BY_REGION] : undefined;
      return <div key={`${value}-${index}`} className="my-2 flex min-w-0 flex-wrap items-center gap-2 rounded-xl border border-line bg-white p-3">
        <input type="hidden" name={name} value={value}/>
        <div className="min-w-0 flex-1"><span className="break-words font-semibold">{value}</span>{name === 'targetCountry' ? <p className="mb-0 mt-1 text-xs text-muted">{hosts?.length ? `Covered · ${hosts.join(', ')}` : 'Not covered · discovery will skip this country until an official host is verified.'}</p> : null}</div>
        <button className={ui.secondaryButton} type="button" onClick={() => setValues(values.filter((_, itemIndex) => itemIndex !== index))} aria-label={`Remove ${value}`}>Remove</button>
      </div>;
    })}
    <div className="mt-3 flex min-w-0 flex-wrap gap-2"><label className="sr-only" htmlFor={`${name}-new`}>Add {label.toLowerCase()}</label><input id={`${name}-new`} className={`${ui.input} min-w-[12rem] flex-1`} value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); add(); } }} placeholder={placeholder} maxLength={name === 'targetCountry' ? 120 : 300}/><button className={ui.secondaryButton} type="button" onClick={add}>Add</button></div>
    {values.length === 0 ? <p className="mb-0 mt-2 text-sm text-red">Add at least one {label.toLowerCase()} before saving.</p> : null}
  </fieldset>;
}

export function ResearchPreferencesEditor({ countries: initialCountries, interests: initialInterests }: { countries: string[]; interests: string[] }) {
  const [countries, setCountries] = useState(initialCountries);
  const [interests, setInterests] = useState(initialInterests);
  return <div className="grid min-w-0 gap-4 md:grid-cols-2">
    <PreferenceList label="Target countries" name="targetCountry" values={countries} setValues={setCountries} placeholder="Add a country"/>
    <PreferenceList label="Research interests" name="researchInterest" values={interests} setValues={setInterests} placeholder="Add a research interest"/>
  </div>;
}
