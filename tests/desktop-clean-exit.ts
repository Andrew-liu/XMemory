import { _electron as electron, expect } from '@playwright/test'
import { mkdirSync,mkdtempSync,existsSync } from 'node:fs'
import path from 'node:path'
const root=path.resolve('../../trash/xmemeory-dev/clean-exit');mkdirSync(root,{recursive:true})
const profile=mkdtempSync(path.join(root,'profile-'))
const env:Record<string,string>={...Object.fromEntries(Object.entries(process.env).filter((e):e is [string,string]=>e[1]!==undefined)),XMEMEORY_TEST_DATA:profile};delete env.ELECTRON_RUN_AS_NODE
const app=await electron.launch({...process.env.XMEMEORY_TEST_EXE?{executablePath:process.env.XMEMEORY_TEST_EXE,args:[]}:{args:['.']},env})
try{
  const page=await app.firstWindow()
  await expect(page.getByRole('heading',{name:'这一周的灵感'})).toBeVisible()
  await app.evaluate(({dialog})=>{(globalThis as any).closeDialogCount=0;dialog.showMessageBox=(async()=>{(globalThis as any).closeDialogCount++;return {response:0,checkboxChecked:false}}) as typeof dialog.showMessageBox})
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),{timeout:2500}).toBe(false)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show())
  await page.getByRole('button',{name:'设置',exact:true}).click()
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),{timeout:2500}).toBe(false)
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].show())
  await page.getByRole('button',{name:'新灵感',exact:true}).click()
  await page.getByRole('button',{name:'切换 Markdown 源码'}).click()
  await page.getByRole('textbox',{name:'Markdown 源码'}).fill('已保存的正文')
  await expect(page.getByText('已保存到本地',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'切换 Markdown 源码'}).click()
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close())
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].isVisible()),{timeout:2500}).toBe(false)
  expect(await app.evaluate(()=>(globalThis as any).closeDialogCount)).toBe(0)
  expect(existsSync(path.join(profile,'recovery'))).toBe(false)
  console.log('PASS: 无编辑日历、设置浏览、已保存正文切换预览后关闭均无恢复弹窗，无恢复副本')
}finally{await app.close()}
