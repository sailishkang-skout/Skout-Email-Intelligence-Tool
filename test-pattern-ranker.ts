import {
  rankEmailCandidates
} from "./src/services/patternRanker.js";

const candidates = [
  {
    email: "patrick@stripe.com",
    pattern: "first@domain",
    rank: 1
  },
  {
    email: "collison@stripe.com",
    pattern: "last@domain",
    rank: 2
  },
  {
    email: "patrick.collison@stripe.com",
    pattern: "first.last@domain",
    rank: 3
  },
  {
    email: "patrickcollison@stripe.com",
    pattern: "firstlast@domain",
    rank: 4
  }
];

const result = rankEmailCandidates(
  "stripe.com",
  candidates
);

console.log(
  JSON.stringify(
    result,
    null,
    2
  )
);
