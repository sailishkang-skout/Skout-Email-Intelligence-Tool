import { generateEmailPermutations } from "../src/services/emailPermutationEngine.js";
const result = generateEmailPermutations({
    firstName: "Patrick",
    lastName: "Collison",
    domain: "stripe.com"
});
console.log(JSON.stringify(result, null, 2));
//# sourceMappingURL=testEmailPermutation.js.map