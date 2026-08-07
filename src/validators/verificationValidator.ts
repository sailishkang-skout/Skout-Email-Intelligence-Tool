import { z } from "zod";


export const VerifyRequestSchema =
z.object({

 email:
   z.string().email(),

});



export type VerifyRequest =
z.infer<
 typeof VerifyRequestSchema
>;