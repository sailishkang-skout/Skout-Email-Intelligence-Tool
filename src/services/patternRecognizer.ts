export interface RecognizedPattern {

  pattern: string;

  score: number;

  confidence:
    | "high"
    | "medium"
    | "low";

}

export function recognizeEmailPattern(
  email: string
): RecognizedPattern {

  const normalizedEmail =
    email
      .trim()
      .toLowerCase();

  const parts =
    normalizedEmail.split("@");

  const localPart =
    parts.at(0) ?? "";

  if (!localPart) {

    return {

      pattern:
        "unknown",

      score: 0,

      confidence:
        "low"

    };

  }

  /*
  ----------------------------------------------
  first.last@domain
  ----------------------------------------------
  */

  if (
    localPart.includes(".")
  ) {

    const dotParts =
      localPart.split(".");

    if (
      dotParts.length === 2 &&
      dotParts[0] &&
      dotParts[1]
    ) {

      return {

        pattern:
          "first.last@domain",

        score: 90,

        confidence:
          "high"

      };

    }

  }

  /*
  ----------------------------------------------
  first@domain
  ----------------------------------------------
  */

  if (
    /^[a-z]+$/i.test(
      localPart
    )
  ) {

    return {

      pattern:
        "first@domain",

      score: 85,

      confidence:
        "high"

    };

  }

  /*
  ----------------------------------------------
  f.last@domain
  ----------------------------------------------
  */

  if (
    /^[a-z]\.[a-z]+$/i.test(
      localPart
    )
  ) {

    return {

      pattern:
        "f.last@domain",

      score: 70,

      confidence:
        "medium"

    };

  }

  /*
  ----------------------------------------------
  flast@domain
  ----------------------------------------------
  */

  if (
    /^[a-z][a-z]+$/i.test(
      localPart
    )
  ) {

    return {

      pattern:
        "flast@domain",

      score: 75,

      confidence:
        "medium"

    };

  }

  return {

    pattern:
      "unknown",

    score: 40,

    confidence:
      "low"

  };

}