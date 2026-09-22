import { _electron as electron } from '@playwright/test'
import { mkdirSync, mkdtempSync } from 'node:fs'
import path from 'node:path'
const temp=path.resolve('../../trash/xmemeory-dev/network');mkdirSync(temp,{recursive:true})
const env: Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),XMEMEORY_TEST_DATA:mkdtempSync(path.join(temp,'profile-'))};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({...process.env.XMEMEORY_TEST_EXE?{executablePath:process.env.XMEMEORY_TEST_EXE,args:[]}:{args:['.']},env})
try {
  console.log(await app.evaluate(async ({session})=>{
    const chromium=session.fromPartition('xmemeory-x-network')
    const proxy=await chromium.resolveProxy('https://x.com')
    const results: unknown[]=[]
    for(const request of [fetch,chromium.fetch.bind(chromium)]) {try{const r=await request('https://x.com',{signal:AbortSignal.timeout(15000),credentials:'omit'});await r.body?.cancel();results.push({status:r.status})}catch(e){const error=e as Error & {cause?:{code?:string}};results.push({error:error.name,code:error.cause?.code || error.message.match(/net::ERR_[A-Z_]+/)?.[0] || 'network failure'})}}
    return {proxyMode:proxy==='DIRECT'?'DIRECT':'PROXY',node:results[0],chromium:results[1]}
  }))
}finally{await app.close()}
