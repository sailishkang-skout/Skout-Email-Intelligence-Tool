import {
  discoverEmail
} from "./src/services/emailDiscoveryEngine.js";

const result = await discoverEmail({
  firstName: "Patrick",
  lastName: "Collison",
  domain: "stripe.com",
  maxVerifications: 3,
  verify: true
});

console.log(
  JSON.stringify(
    result,
    null,
    2
  )
);
