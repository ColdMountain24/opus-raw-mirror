// Loop 1 (The Agora) framework content and the design-to-framework lookup.
//
// A study DESIGN (a deterministic label the extraction emits, e.g. "case_control")
// maps to one or more reporting-guideline FRAMEWORK ids (e.g. "STROBE") via
// DESIGN_TO_FRAMEWORKS. The framework id is NEVER emitted by the LLM: the extraction
// emits the design, and DesignLookup resolves the framework client-side. Each
// framework id maps to a full field set (the reporting checklist) that lives only
// in the FrameworkRegistry, so framework CONTENT never enters an LLM prompt.
//
// Charter boundary. The DESIGN_TO_FRAMEWORKS anchors are the user-supplied FINAL
// mapping. The per-framework field set CONTENTS are implemented here (the spec left
// them to judgment): concise reporting-checklist sections per guideline, enough to
// be useful downstream without reproducing the full published checklists.

// The FINAL design -> framework(s) anchors. A design may map to more than one
// framework (a meta-analysis carries both the review and the meta-analysis guides).
export const DESIGN_TO_FRAMEWORKS = Object.freeze({
  retrospective_cohort: ['STROBE'],
  prospective_cohort: ['STROBE'],
  case_control: ['STROBE'],
  cross_sectional: ['STROBE'],
  randomized_controlled_trial: ['CONSORT'],
  systematic_review: ['PRISMA'],
  systematic_review_with_meta: ['PRISMA', 'PRISMA-MA'],
  scoping_review: ['PRISMA-ScR'],
  ml_classification: ['TRIPOD'],
  simulation: ['TRACE'],
  constructive: ['RAW_CONSTRUCTIVE'],
  theoretical: ['RAW_THEORETICAL'],
  experimental_lab: ['ARRIVE_2'],
});

// Per-framework field sets (the reporting checklist). Contents are this module's
// judgment; the registry stores them frozen and they are looked up client-side, never
// placed in a prompt. Each entry: a human name, the paradigm it serves, and the
// checklist sections a study following that guideline must report.
export const FRAMEWORK_DEFINITIONS = Object.freeze({
  STROBE: {
    name: 'STROBE',
    title: 'Strengthening the Reporting of Observational Studies in Epidemiology',
    paradigm: 'observational',
    sections: ['study design', 'setting', 'participants', 'variables', 'bias', 'statistical methods', 'outcome data'],
  },
  CONSORT: {
    name: 'CONSORT',
    title: 'Consolidated Standards of Reporting Trials',
    paradigm: 'interventional',
    sections: ['trial design', 'randomization', 'allocation concealment', 'blinding', 'participant flow', 'outcomes and estimation', 'harms'],
  },
  PRISMA: {
    name: 'PRISMA',
    title: 'Preferred Reporting Items for Systematic Reviews and Meta-Analyses',
    paradigm: 'synthesis',
    sections: ['eligibility criteria', 'information sources', 'search strategy', 'selection process', 'data collection', 'risk of bias', 'synthesis methods'],
  },
  'PRISMA-MA': {
    name: 'PRISMA-MA',
    title: 'PRISMA meta-analysis extension',
    paradigm: 'synthesis',
    sections: ['effect measures', 'pooling methods', 'heterogeneity assessment', 'sensitivity analysis', 'certainty of evidence'],
  },
  'PRISMA-ScR': {
    name: 'PRISMA-ScR',
    title: 'PRISMA extension for Scoping Reviews',
    paradigm: 'synthesis',
    sections: ['review questions', 'eligibility criteria', 'charting the data', 'mapping the results', 'evidence gaps'],
  },
  TRIPOD: {
    name: 'TRIPOD',
    title: 'Transparent Reporting of a multivariable prediction model',
    paradigm: 'computational',
    sections: ['source of data', 'predictors', 'outcome', 'sample size', 'model building', 'model performance', 'validation'],
  },
  TRACE: {
    name: 'TRACE',
    title: 'Transparent And Comprehensive model Evaluation',
    paradigm: 'computational',
    sections: ['problem definition', 'model structure', 'parameterization', 'calibration', 'sensitivity analysis', 'validation experiments'],
  },
  RAW_CONSTRUCTIVE: {
    name: 'RAW_CONSTRUCTIVE',
    title: 'RAW constructive (artifact) reporting',
    paradigm: 'constructive',
    sections: ['requirements', 'artifact design', 'implementation', 'demonstration', 'evaluation against objectives'],
  },
  RAW_THEORETICAL: {
    name: 'RAW_THEORETICAL',
    title: 'RAW theoretical (analytical) reporting',
    paradigm: 'theoretical',
    sections: ['assumptions', 'definitions', 'propositions', 'proofs or arguments', 'scope conditions', 'implications'],
  },
  ARRIVE_2: {
    name: 'ARRIVE_2',
    title: 'Animal Research: Reporting of In Vivo Experiments 2.0',
    paradigm: 'experimental',
    sections: ['study design', 'sample size', 'inclusion and exclusion criteria', 'randomization', 'blinding', 'outcome measures', 'experimental procedures'],
  },
});

// DesignLookup: the framework ids a design maps to, deterministically (never via the
// LLM). Unknown or absent designs map to no framework.
export function frameworksForDesign(design) {
  if (typeof design !== 'string') return [];
  const ids = DESIGN_TO_FRAMEWORKS[design];
  return ids ? ids.slice() : [];
}

// The full set of design labels the extraction may emit (the DesignLookup keys).
export const DESIGN_IDS = Object.freeze(Object.keys(DESIGN_TO_FRAMEWORKS));

// Register every framework definition into a registry instance (idempotent per
// instance: a definition is registered once). main.js seeds the app registry at
// startup; tests seed a fresh registry.
export function seedFrameworkRegistry(registry) {
  for (const [id, definition] of Object.entries(FRAMEWORK_DEFINITIONS)) {
    if (!registry.has(id)) registry.register(id, definition);
  }
  return registry;
}
