import { _electron as electron, expect } from '@playwright/test'
import { createServer } from 'node:http'
import { mkdirSync,mkdtempSync } from 'node:fs'
import path from 'node:path'
const server=createServer((req,res)=>{res.writeHead(req.url==='/redirect'?302:200,req.url==='/redirect'?{location:'/echo'}:{'content-type':'application/json'});res.end(JSON.stringify({cookie:req.headers.cookie || ''}))})
await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve))
const address=server.address();if(!address || typeof address==='string')throw new Error('server unavailable')
const root=path.resolve('../../trash/xmemeory-dev/network');mkdirSync(root,{recursive:true})
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),XMEMEORY_TEST_DATA:mkdtempSync(path.join(root,'isolated-'))};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({...process.env.XMEMEORY_TEST_EXE?{executablePath:process.env.XMEMEORY_TEST_EXE,args:[]}:{args:['.']},env})
try {
  const result=await app.evaluate(async({session},origin)=>{
    const isolated=session.fromPartition('xmemeory-x-network')
    await isolated.cookies.set({url:origin,name:'unwanted',value:'synthetic-session'})
    const response=await isolated.fetch(origin+'/echo',{headers:{Cookie:'auth_token=synthetic-export'},credentials:'omit',redirect:'error'})
    const body=await response.json()
    let blocked=false
    try{await isolated.fetch(origin+'/redirect',{headers:{Cookie:'auth_token=synthetic-export'},credentials:'omit',redirect:'error'})}catch{blocked=true}
    return {body,blocked}
  },`http://127.0.0.1:${address.port}`)
  expect(result.body.cookie).toBe('auth_token=synthetic-export')
  expect(result.blocked).toBe(true)
  console.log('PASS: Chromium 保留显式导出 Cookie、不携带会话 Cookie、阻止重定向')
}finally{await app.close();server.close()}
