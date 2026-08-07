import {
  BaseRepository
} from "./baseRepository.js";


/*
==================================================
EVIDENCE REPOSITORY
==================================================

Purpose:

Persistence layer for verification evidence.

Responsibilities:

- save evidence records
- fetch evidence by verification
- maintain evidence history

Does NOT:

- calculate confidence
- classify email status
- make decisions

==================================================
*/


export interface CreateEvidenceInput {

  verificationId:string;

  evidenceType:string;

  source:string;

  signal:string;

  value?:string|null;

  confidenceScore?:number|null;

  metadata?:unknown;

}



export interface VerificationEvidenceRecord {

  id:string;

  verification_id:string;

  evidence_type:string;

  source:string;

  signal:string;

  value:string|null;

  confidence_score:number|null;

  metadata:string|null;

  created_at:string;

}



export class EvidenceRepository
extends BaseRepository {


  /*
  ==================================================
  SAVE EVIDENCE
  ==================================================
  */


  save(
    input:CreateEvidenceInput
  ):void {


    this.executeRun(
`
INSERT INTO verification_evidence
(
 id,
 verification_id,
 evidence_type,
 source,
 signal,
 value,
 confidence_score,
 metadata,
 created_at
)

VALUES
(
 ?,
 ?,
 ?,
 ?,
 ?,
 ?,
 ?,
 ?,
 ?
)

`,
      this.uuid(),

      input.verificationId,

      input.evidenceType,

      input.source,

      input.signal,

      input.value ?? null,

      input.confidenceScore ?? null,

      input.metadata
        ? JSON.stringify(input.metadata)
        : null,

      this.now()

    );


  }



  /*
  ==================================================
  FIND BY VERIFICATION
  ==================================================
  */


  findByVerificationId(
    verificationId:string
  ):VerificationEvidenceRecord[] {


    return this.queryMany<VerificationEvidenceRecord>(
`
SELECT *

FROM verification_evidence

WHERE verification_id = ?

ORDER BY created_at ASC
`,
      verificationId
    );


  }



  /*
  ==================================================
  DELETE EVIDENCE
  ==================================================
  */


  deleteByVerificationId(
    verificationId:string
  ):number {


    return this.executeDelete(
`
DELETE FROM verification_evidence

WHERE verification_id = ?
`,
      verificationId
    );


  }


}
