import {
  getPatternIntelligence
} from "./src/services/patternIntelligence.js";

const result = getPatternIntelligence("stripe.com");

console.log(JSON.stringify(result, null, 2));
