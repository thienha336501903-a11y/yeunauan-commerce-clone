import test from "node:test";
import assert from "node:assert/strict";
import { getAgencyPrimarySurfaceHost, getAgencySurfaceOriginOrFallback } from "../utils/agency-surface.js";

function client(rows,error=null){
  return {
    from(){
      return {
        select(){
          return {
            eq(){
              return {
                eq(){
                  return {
                    eq(){
                      return {
                        eq(){
                          return {
                            order(){
                              return {
                                limit: async()=>({data:rows,error})
                              };
                            }
                          };
                        }
                      };
                    }
                  };
                }
              };
            }
          };
        }
      };
    }
  };
}

test("Agency LMS navigation resolves exactly one typed primary host", async () => {
  const out=await getAgencyPrimarySurfaceHost("agency-1","lms",{supabaseClient:client([
    {hostname:"learn.example.com",surface:"lms",is_primary:true,status:"active",ssl_status:"active"}
  ])});
  assert.equal(out.ok,true);
  assert.equal(out.origin,"https://learn.example.com");
});

test("Agency surface lookup fails closed when ambiguous", async () => {
  const out=await getAgencyPrimarySurfaceHost("agency-1","lms",{supabaseClient:client([
    {hostname:"a.example.com",surface:"lms",is_primary:true,status:"active",ssl_status:"active"},
    {hostname:"b.example.com",surface:"lms",is_primary:false,status:"active",ssl_status:"active"}
  ])});
  assert.equal(out.ok,false);
  assert.equal(out.code,"agency_surface_ambiguous");
});

test("Historical Agency can use explicit global fallback only when enabled", async () => {
  const origin=await getAgencySurfaceOriginOrFallback("agency-a","lms","https://hoc.yeubep.shop",{
    supabaseClient:client([]),allowUntypedFallback:true
  });
  assert.equal(origin,"https://hoc.yeubep.shop");
});
