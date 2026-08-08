import {
  createVerificationJob,
  getVerificationJob
} from "../src/services/verificationJobService.js";


import {
  runVerificationWorker
} from "../src/services/verificationWorker.js";



async function main(){


 const emails = [

  "test@gmail.com",

  "hello@example.com",

  "invalid-email-test@nonexistentdomain123456.com"

 ];



 const job =
   await createVerificationJob(
     emails
   );



 console.log(
   "CREATED JOB",
   job
 );



 await runVerificationWorker(
   job.jobId
 );



 const result =
   getVerificationJob(
     job.jobId
   );



 console.log(
   "FINAL JOB",
   result
 );

}



main()
.catch(console.error);

