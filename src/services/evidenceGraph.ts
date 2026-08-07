/*
==================================================
EVIDENCE GRAPH ENGINE
==================================================

Purpose

Build an explainable evidence graph describing
how every verification signal contributed to the
final verification outcome.

The graph is read-only.

It does NOT:

- perform SMTP verification
- calculate confidence
- make recommendations
- record database events

It only builds relationships between evidence.

==================================================
*/

import type {
  WeightedEvidence
} from "./evidenceWeighting.js";

/*
==================================================
NODE TYPES
==================================================
*/

export type EvidenceGraphNodeType =
  | "EVIDENCE"
  | "CONFIDENCE"
  | "DECISION"
  | "RECOMMENDATION";

/*
==================================================
EDGE TYPES
==================================================
*/

export type EvidenceGraphEdgeType =
  | "SUPPORTS"
  | "WEAKENS"
  | "RESULTS_IN";

/*
==================================================
GRAPH NODE
==================================================
*/

export interface EvidenceGraphNode {

  id:string;

  label:string;

  type:EvidenceGraphNodeType;

  score?:number;

  metadata?:
    Record<string,unknown>;

}

/*
==================================================
GRAPH EDGE
==================================================
*/

export interface EvidenceGraphEdge {

  from:string;

  to:string;

  relationship:
    EvidenceGraphEdgeType;

  weight:number;

}

/*
==================================================
GRAPH
==================================================
*/

export interface EvidenceGraph {

  nodes:
    EvidenceGraphNode[];

  edges:
    EvidenceGraphEdge[];

  rootEvidence:
    string[];

  terminalNode:
    string|null;

  decisionPath:
    string[];

}

/*
==================================================
INPUT
==================================================
*/

export interface EvidenceGraphInput {

  evidence:
    WeightedEvidence[];

  confidenceScore:number;

  confidenceLevel:string;

  decision:string;

  recommendation:string;

}

/*
==================================================
HELPERS
==================================================
*/

function nodeId(

  prefix:string,

  value:string

){

  return `${prefix}:${value}`;

}

function createEvidenceNode(

  evidence:WeightedEvidence

):EvidenceGraphNode{

  return{

    id:

      nodeId(
        "evidence",
        evidence.type
      ),

    label:
      evidence.description,

    type:
      "EVIDENCE",

    score:
      evidence.weight,

    metadata:{

      evidenceType:
        evidence.type,

      positive:
        evidence.positive

    }

  };

}

function createConfidenceNode(

  score:number,

  level:string

):EvidenceGraphNode{

  return{

    id:"confidence",

    label:
      level,

    type:
      "CONFIDENCE",

    score,

    metadata:{

      level

    }

  };

}

function createDecisionNode(

  decision:string

):EvidenceGraphNode{

  return{

    id:"decision",

    label:
      decision,

    type:
      "DECISION"

  };

}

function createRecommendationNode(

  recommendation:string

):EvidenceGraphNode{

  return{

    id:"recommendation",

    label:
      recommendation,

    type:
      "RECOMMENDATION"

  };

}
/*
==================================================
GRAPH BUILDER
==================================================
*/

function buildEvidenceEdges(
  evidence:WeightedEvidence[]
):EvidenceGraphEdge[]{

  const edges:EvidenceGraphEdge[]=[];

  for(const item of evidence){

    edges.push({

      from:
        nodeId(
          "evidence",
          item.type
        ),

      to:
        "confidence",

      relationship:
        item.positive
          ? "SUPPORTS"
          : "WEAKENS",

      weight:
        Math.abs(
          item.weight
        )

    });

  }

  return edges;

}

function buildConfidenceEdges():EvidenceGraphEdge[]{

  return [

    {

      from:
        "confidence",

      to:
        "decision",

      relationship:
        "RESULTS_IN",

      weight:
        100

    },

    {

      from:
        "decision",

      to:
        "recommendation",

      relationship:
        "RESULTS_IN",

      weight:
        100

    }

  ];

}

/*
==================================================
NODE COLLECTION
==================================================
*/

function buildNodes(
  input:EvidenceGraphInput
):EvidenceGraphNode[]{

  const nodes:EvidenceGraphNode[]=[];

  for(
    const evidence of input.evidence
  ){

    nodes.push(

      createEvidenceNode(
        evidence
      )

    );

  }

  nodes.push(

    createConfidenceNode(

      input.confidenceScore,

      input.confidenceLevel

    )

  );

  nodes.push(

    createDecisionNode(

      input.decision

    )

  );

  nodes.push(

    createRecommendationNode(

      input.recommendation

    )

  );

  return nodes;

}

/*
==================================================
EDGE COLLECTION
==================================================
*/

function buildEdges(
  input:EvidenceGraphInput
):EvidenceGraphEdge[]{

  return [

    ...buildEvidenceEdges(
      input.evidence
    ),

    ...buildConfidenceEdges()

  ];

}
/*
==================================================
ROOT EVIDENCE
==================================================
*/

function collectRootEvidence(
  evidence:WeightedEvidence[]
):string[]{

  return evidence.map(

    item =>

      nodeId(
        "evidence",
        item.type
      )

  );

}

/*
==================================================
DECISION PATH
==================================================
*/

function buildDecisionPath(
  evidence:WeightedEvidence[]
):string[]{

  const ordered =

    [...evidence].sort(

      (a,b)=>

        Math.abs(b.weight) -
        Math.abs(a.weight)

    );

  return [

    ...ordered.map(
      item => item.type
    ),

    "CONFIDENCE",

    "DECISION",

    "RECOMMENDATION"

  ];

}

/*
==================================================
PUBLIC API
==================================================
*/

export function buildEvidenceGraph(
  input:EvidenceGraphInput
):EvidenceGraph{

  const nodes =
    buildNodes(
      input
    );

  const edges =
    buildEdges(
      input
    );

  const rootEvidence =
    collectRootEvidence(
      input.evidence
    );

  const decisionPath =
    buildDecisionPath(
      input.evidence
    );

  return{

    nodes,

    edges,

    rootEvidence,

    terminalNode:
      "recommendation",

    decisionPath

  };

}

/*
==================================================
GRAPH SUMMARY
==================================================

Example:

SMTP_SUCCESS
        │
        ▼
MAILBOX_EXISTS
        │
        ▼
CONFIDENCE
        │
        ▼
DECISION
        │
        ▼
RECOMMENDATION

==================================================
*/
