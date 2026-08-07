import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readFile
} from "node:fs/promises";
import path from "node:path";


/*
==================================================
EVIDENCE TIMELINE
==================================================

Stores every verification event.

Example:

DNS
 |
SMTP
 |
CATCH_ALL
 |
CONFIDENCE
 |
DECISION

==================================================
*/


const STORAGE_DIR =
  path.resolve(
    process.env.EVIDENCE_TIMELINE_DIR ??
    "./data"
  );


const STORAGE_FILE =
  path.join(
    STORAGE_DIR,
    "evidence-timeline.jsonl"
  );



export type TimelineStage =
  | "DNS"
  | "SMTP"
  | "CATCH_ALL"
  | "PATTERN"
  | "CONFIDENCE"
  | "DECISION"
  | "SYSTEM";


export interface EvidenceTimelineInput {

  verificationId:string;

  stage:TimelineStage;

  event:string;

  data?:Record<string,unknown>;

}



export interface EvidenceTimelineRecord
extends EvidenceTimelineInput {

  id:string;

  timestamp:string;

  version:1;

}



/*
==================================================
WRITE EVENT
==================================================
*/


export async function recordTimelineEvent(
  input:EvidenceTimelineInput
):Promise<EvidenceTimelineRecord>{


  const record:EvidenceTimelineRecord = {


    id:
      randomUUID(),


    timestamp:
      new Date().toISOString(),


    version:1,


    verificationId:
      input.verificationId,


    stage:
      input.stage,


    event:
      input.event,


    data:
      input.data ?? {}

  };



  await mkdir(
    STORAGE_DIR,
    {
      recursive:true
    }
  );



  await appendFile(

    STORAGE_FILE,

    JSON.stringify(record)
    + "\n",

    "utf8"

  );


  return record;

}



/*
==================================================
READ TIMELINE
==================================================
*/


export async function getVerificationTimeline(
  verificationId:string
):Promise<EvidenceTimelineRecord[]>{


  try{


    const content =
      await readFile(
        STORAGE_FILE,
        "utf8"
      );


    return content

      .split("\n")

      .filter(Boolean)

      .map(
        line =>
          JSON.parse(line)
      )

      .filter(
        record =>
          record.verificationId === verificationId
      )

      .sort(
        (a,b)=>
          new Date(a.timestamp).getTime()
          -
          new Date(b.timestamp).getTime()
      );


  }catch(error:any){


    if(error.code==="ENOENT"){

      return [];

    }


    throw error;

  }

}