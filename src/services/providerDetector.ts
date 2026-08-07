export interface ProviderResult {

  provider:
    | "GOOGLE_WORKSPACE"
    | "MICROSOFT_365"
    | "PROOFPOINT"
    | "MIMECAST"
    | "ZOHO"
    | "OTHER";


  confidence:
    | "high"
    | "medium"
    | "low";


  mxHosts:string[];

  reason:string;

}




export function detectProvider(
  mxHosts:string[]
):ProviderResult {


  const hosts =
    mxHosts.map(
      h => h.toLowerCase()
    );



  /*
    Google Workspace
  */

  if(
    hosts.some(
      h =>
      h.includes("google.com") ||
      h.includes("googlemail.com")
    )
  ){

    return {

      provider:
        "GOOGLE_WORKSPACE",

      confidence:
        "high",

      mxHosts,

      reason:
        "Google Workspace MX records detected"

    };

  }




  /*
    Microsoft 365
  */

  if(
    hosts.some(
      h =>
      h.includes("protection.outlook.com")
    )
  ){

    return {

      provider:
        "MICROSOFT_365",

      confidence:
        "high",

      mxHosts,

      reason:
        "Microsoft 365 MX records detected"

    };

  }





  /*
    Proofpoint
  */

  if(
    hosts.some(
      h =>
      h.includes("proofpoint")
    )
  ){

    return {

      provider:
        "PROOFPOINT",

      confidence:
        "high",

      mxHosts,

      reason:
        "Proofpoint email security detected"

    };

  }





  /*
    Mimecast
  */

  if(
    hosts.some(
      h =>
      h.includes("mimecast")
    )
  ){

    return {

      provider:
        "MIMECAST",

      confidence:
        "high",

      mxHosts,

      reason:
        "Mimecast email security detected"

    };

  }





  /*
    Zoho
  */

  if(
    hosts.some(
      h =>
      h.includes("zoho")
    )
  ){

    return {

      provider:
        "ZOHO",

      confidence:
        "medium",

      mxHosts,

      reason:
        "Zoho Mail MX detected"

    };

  }





  return {

    provider:
      "OTHER",

    confidence:
      "low",

    mxHosts,

    reason:
      "No known provider detected"

  };


}