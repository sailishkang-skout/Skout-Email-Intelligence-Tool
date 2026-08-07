/*
==================================================
EMAIL PERMUTATION ENGINE
==================================================

Purpose:

Generate deterministic email candidates from:

- first name
- last name
- optional middle name
- domain

Example:

Patrick Collison
stripe.com

Produces candidates such as:

patrick@stripe.com
collison@stripe.com
patrick.collison@stripe.com
patrickcollison@stripe.com
p.collison@stripe.com
pcollison@stripe.com
collison.patrick@stripe.com

This service DOES NOT:

- perform SMTP verification
- query DNS
- query pattern history
- make AI decisions
- claim that an email exists

It only generates candidate addresses.

==================================================
*/

export interface EmailPermutationInput {
  firstName: string;
  lastName?: string | null;
  middleName?: string | null;
  domain: string;
}

export interface EmailPermutationCandidate {
  email: string;
  pattern: string;
  rank: number;
}

export interface EmailPermutationResult {
  firstName: string;
  lastName: string | null;
  middleName: string | null;
  domain: string;
  candidates: EmailPermutationCandidate[];
}

/*
==================================================
NORMALIZATION
==================================================
*/

function normalizeName(
  value: string | null | undefined
): string {
  if (!value) {
    return "";
  }

  return value
    .normalize("NFKD")
    .replace(
      /[\u0300-\u036f]/g,
      ""
    )
    .toLowerCase()
    .replace(
      /[^a-z0-9]/g,
      ""
    )
    .trim();
}

function normalizeDomain(
  domain: string
): string {
  const normalized =
    domain
      .trim()
      .toLowerCase()
      .replace(
        /^https?:\/\//,
        ""
      )
      .replace(
        /^www\./,
        ""
      );

  return (
    normalized
      .split("/")[0]
      ?.trim() ?? ""
  );
}

/*
==================================================
DOMAIN VALIDATION
==================================================
*/

function validateDomain(
  domain: string
): boolean {

  if (!domain) {
    return false;
  }

  return (
    domain.length <= 253 &&
    domain.includes(".") &&
    !domain.includes(" ") &&
    /^[a-z0-9.-]+$/i.test(domain)
  );
}

/*
==================================================
CANDIDATE BUILDER
==================================================
*/

function buildCandidate(
  localPart: string,
  pattern: string,
  rank: number,
  domain: string
): EmailPermutationCandidate | null {

  const normalizedLocalPart =
    localPart
      .toLowerCase()
      .replace(
        /[^a-z0-9._-]/g,
        ""
      );

  if (!normalizedLocalPart) {
    return null;
  }

  return {
    email:
      `${normalizedLocalPart}@${domain}`,

    pattern,

    rank
  };
}

/*
==================================================
MAIN PERMUTATION ENGINE
==================================================
*/

export function generateEmailPermutations(
  input: EmailPermutationInput
): EmailPermutationResult {

  const firstName =
    normalizeName(
      input.firstName
    );

  const lastName =
    normalizeName(
      input.lastName
    );

  const middleName =
    normalizeName(
      input.middleName
    );

  const domain =
    normalizeDomain(
      input.domain
    );

  /*
  --------------------------------------------------
  VALIDATION
  --------------------------------------------------
  */

  if (!firstName) {
    throw new Error(
      "First name is required"
    );
  }

  if (!validateDomain(domain)) {
    throw new Error(
      `Invalid domain: ${input.domain}`
    );
  }

  /*
  --------------------------------------------------
  CANDIDATE COLLECTION
  --------------------------------------------------
  */

  const candidates:
    EmailPermutationCandidate[] = [];

  const seen =
    new Set<string>();

  const add = (
    localPart: string,
    pattern: string
  ): void => {

    const candidate =
      buildCandidate(
        localPart,
        pattern,
        candidates.length + 1,
        domain
      );

    if (!candidate) {
      return;
    }

    const key =
      candidate.email;

    if (seen.has(key)) {
      return;
    }

    seen.add(key);

    candidates.push(
      candidate
    );
  };

  /*
  ==================================================
  FIRST NAME
  ==================================================
  */

  add(
    firstName,
    "first@domain"
  );

  /*
  ==================================================
  LAST NAME
  ==================================================
  */

  if (lastName) {

    add(
      lastName,
      "last@domain"
    );

  }

  /*
  ==================================================
  FIRST + LAST
  ==================================================
  */

  if (lastName) {

    add(
      `${firstName}.${lastName}`,
      "first.last@domain"
    );

    add(
      `${firstName}${lastName}`,
      "firstlast@domain"
    );

    add(
      `${firstName}_${lastName}`,
      "first_last@domain"
    );

    add(
      `${firstName}-${lastName}`,
      "first-last@domain"
    );

  }

  /*
  ==================================================
  FIRST INITIAL + LAST
  ==================================================
  */

  if (lastName) {

    const firstInitial =
      firstName[0];

    if (firstInitial) {

      add(
        `${firstInitial}${lastName}`,
        "flast@domain"
      );

      add(
        `${firstInitial}.${lastName}`,
        "f.last@domain"
      );

      add(
        `${firstInitial}_${lastName}`,
        "f_last@domain"
      );

      add(
        `${firstInitial}-${lastName}`,
        "f-last@domain"
      );

    }

  }

  /*
  ==================================================
  FIRST + LAST INITIAL
  ==================================================
  */

  if (lastName) {

    const lastInitial =
      lastName[0];

    if (lastInitial) {

      add(
        `${firstName}${lastInitial}`,
        "firstl@domain"
      );

      add(
        `${firstName}.${lastInitial}`,
        "first.l@domain"
      );

      add(
        `${firstName}_${lastInitial}`,
        "first_l@domain"
      );

      add(
        `${firstName}-${lastInitial}`,
        "first-l@domain"
      );

    }

  }

  /*
  ==================================================
  FIRST INITIAL + LAST INITIAL
  ==================================================
  */

  if (lastName) {

    const firstInitial =
      firstName[0];

    const lastInitial =
      lastName[0];

    if (
      firstInitial &&
      lastInitial
    ) {

      add(
        `${firstInitial}${lastInitial}`,
        "fl@domain"
      );

      add(
        `${firstInitial}.${lastInitial}`,
        "f.l@domain"
      );

      add(
        `${firstInitial}_${lastInitial}`,
        "f_l@domain"
      );

      add(
        `${firstInitial}-${lastInitial}`,
        "f-l@domain"
      );

    }

  }

  /*
  ==================================================
  REVERSED NAME
  ==================================================
  */

  if (lastName) {

    add(
      `${lastName}.${firstName}`,
      "last.first@domain"
    );

    add(
      `${lastName}${firstName}`,
      "lastfirst@domain"
    );

    add(
      `${lastName}_${firstName}`,
      "last_first@domain"
    );

    add(
      `${lastName}-${firstName}`,
      "last-first@domain"
    );

  }

  /*
  ==================================================
  MIDDLE NAME PATTERNS
  ==================================================
  */

  if (
    lastName &&
    middleName
  ) {

    const middleInitial =
      middleName[0];

    if (middleInitial) {

      add(
        `${firstName}.${middleInitial}.${lastName}`,
        "first.middleinitial.last@domain"
      );

      add(
        `${firstName}${middleInitial}${lastName}`,
        "firstmiddleinitiallast@domain"
      );

      add(
        `${firstName}.${middleName}.${lastName}`,
        "first.middle.last@domain"
      );

    }

  }

  /*
  ==================================================
  FINAL RANKING
  ==================================================
  */

  const ranked =
    candidates.map(
      (
        candidate,
        index
      ): EmailPermutationCandidate => ({
        ...candidate,

        rank:
          index + 1
      })
    );

  /*
  ==================================================
  RESULT
  ==================================================
  */

  return {

    firstName,

    lastName:
      lastName || null,

    middleName:
      middleName || null,

    domain,

    candidates:
      ranked

  };

}

/*
==================================================
SIMPLE HELPER
==================================================

Convenience function for callers that only need
the candidate array.

IMPORTANT:

With exactOptionalPropertyTypes enabled, we must
NOT explicitly pass:

    lastName: undefined

Therefore we conditionally spread the property.
==================================================
*/

export function generateEmailCandidates(
  firstName: string,
  lastName: string | null | undefined,
  domain: string
): EmailPermutationCandidate[] {

  return generateEmailPermutations({

    firstName,

    ...(lastName !== undefined
      ? {
          lastName
        }
      : {}),

    domain

  }).candidates;

}