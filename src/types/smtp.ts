export interface NormalizedSMTPResult {

  responseCode:number|null;

  responseMessage:string|null;

  mailboxExists:boolean;

  smtpValid:boolean;

  mxAvailable:boolean;

  mxHosts:string[];

  primaryMX:string|null;

  provider:string|null;

  retryRequired:boolean;

  retryReason:string|null;

  error:string|null;

}
