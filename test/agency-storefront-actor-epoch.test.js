import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const html=fs.readFileSync(new URL("../agency-storefront.html",import.meta.url),"utf8");
const script=html.match(/<script>([\s\S]*?)<\/script>/)?.[1]||"";
const helperEnd=script.indexOf("function setNotice");
if(helperEnd<0)throw new Error("actor helper block not found");
const helper=script.slice(0,helperEnd);

function storage(){
  const map=new Map();
  return {
    get length(){return map.size},
    key(i){return [...map.keys()][i]??null},
    getItem(k){return map.has(k)?map.get(k):null},
    setItem(k,v){map.set(k,String(v))},
    removeItem(k){map.delete(k)}
  };
}

test("Captured actor becomes stale after account change and retains only its own namespace",()=>{
  const elements=new Map();
  const element=id=>{
    if(!elements.has(id))elements.set(id,{
      textContent:"",
      classList:{add(){},remove(){}},
      removeAttribute(){},
      src:""
    });
    return elements.get(id);
  };
  class BroadcastChannelStub{
    addEventListener(){}
    postMessage(){}
  }
  const context=vm.createContext({
    Intl,
    crypto:{randomUUID:()=>"uuid-1"},
    localStorage:storage(),
    window:{},
    BroadcastChannel:BroadcastChannelStub,
    document:{getElementById:element},
    console
  });
  vm.runInContext(helper+