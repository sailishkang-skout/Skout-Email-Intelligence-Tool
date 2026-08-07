import Database from "better-sqlite3";


const db = new Database(
  "data/email-intelligence.db"
);



db.exec(`
CREATE TABLE IF NOT EXISTS verification_history (

 id INTEGER PRIMARY KEY AUTOINCREMENT,

 email TEXT NOT NULL,

 domain TEXT NOT NULL,

 confidence_score INTEGER NOT NULL,

 decision TEXT NOT NULL,

 evidence_json TEXT NOT NULL,

 created_at DATETIME DEFAULT CURRENT_TIMESTAMP

);
`);




export interface VerificationRecord {

 email:string;

 domain:string;

 confidenceScore:number;

 decision:string;

 evidence:Record<string,unknown>;

}




export function saveVerification(
 record:VerificationRecord
){


 const stmt = db.prepare(`

 INSERT INTO verification_history
 (
 email,
 domain,
 confidence_score,
 decision,
 evidence_json
 )

 VALUES
 (
 @email,
 @domain,
 @confidenceScore,
 @decision,
 @evidence
 )

 `);



 return stmt.run({

  email:
    record.email,

  domain:
    record.domain,

  confidenceScore:
    record.confidenceScore,

  decision:
    record.decision,

  evidence:
    JSON.stringify(
      record.evidence
    )

 });


}




export function getVerificationHistory(
 email:string
){


 const stmt = db.prepare(`

 SELECT *

 FROM verification_history

 WHERE email = ?

 ORDER BY created_at DESC

 LIMIT 50

 `);



 return stmt.all(email);

}