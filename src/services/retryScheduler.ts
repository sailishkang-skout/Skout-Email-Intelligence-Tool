export interface RetryPolicy {

  attempts:number;

  delayMs:number;

}


export async function withRetry<T>(
 task:()=>Promise<T>,
 policy:RetryPolicy
):Promise<T>{


 let lastError:unknown;


 for(
   let attempt=1;
   attempt<=policy.attempts;
   attempt++
 ){


  try {

    return await task();

  }

  catch(error){

    lastError = error;


    if(
      attempt === policy.attempts
    ){
      break;
    }


    await new Promise(
      resolve =>
        setTimeout(
          resolve,
          policy.delayMs * attempt
        )
    );

  }


 }


 throw lastError;

}