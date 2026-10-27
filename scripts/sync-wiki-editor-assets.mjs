import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dist=path.join(root,'wiki-editor-react/dist');
const html=fs.readFileSync(path.join(dist,'index.html'),'utf8');
const assets=[...html.matchAll(/(?:src|href)="\.\/(wiki-editor-assets\/[^"]+)"/g)].map(m=>m[1]);
if(assets.length!==2||assets.some(a=>!/^wiki-editor-assets\/index-[\w-]+\.(js|css)$/.test(a)))throw new Error('Unexpected Wiki editor build assets');
const directory=path.join(root,'admin/wiki-editor-assets');const manifest=path.join(directory,'.generated-assets.json');
const previous=fs.existsSync(manifest)?JSON.parse(fs.readFileSync(manifest,'utf8')):[];
for(const relative of assets){fs.mkdirSync(directory,{recursive:true});fs.copyFileSync(path.join(dist,relative),path.join(root,'admin',relative));}
fs.writeFileSync(path.join(root,'admin/wiki_editor.html'),html);
for(const name of previous)if(/^index-[\w-]+\.(js|css)$/.test(name)&&!assets.includes('wiki-editor-assets/'+name)){const target=path.join(directory,name);if(path.dirname(path.resolve(target))!==path.resolve(directory))throw new Error('Invalid generated asset path');if(fs.existsSync(target))fs.unlinkSync(target);}
fs.writeFileSync(manifest,JSON.stringify(assets.map(a=>path.basename(a)),null,2)+'\n');
console.log('Wiki editor shell and hashed assets synchronized');
