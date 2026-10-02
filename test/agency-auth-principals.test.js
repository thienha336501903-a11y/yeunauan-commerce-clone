import test from "node:test";
import assert from "node:assert/strict";
import { findAuthUserByEmail } from "../utils/agency-auth-principals.js";

test("Commerce Google bridge helper can page beyond first Auth page",async()=>{
  let calls=0;
  const client={auth:{admin:{listUsers:async({page})=>{
    calls++;
    if(page===1)return{data:{users:Array.from({length:200},(_,i)=>({id:`u${i}`,email:`u${i}@example.com`}))}};
    return{data:{users:[{id:"target",email:"target@example.com"}]}};
  }}}};
  const out=await findAuthUserByEmail(client,"target@example.com",{perPage:200});
  assert.equal(out.ok,true);
  assert.equal(out.user.id,"target");
  assert.equal(calls,2);
});
