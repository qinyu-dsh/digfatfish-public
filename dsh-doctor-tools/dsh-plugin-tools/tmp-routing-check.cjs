const fs=require("fs"),zstd=require("zlib");
const p=process.argv[1];
const buf=fs.readFileSync(p);
function frames(b){const out=[];let i=0;const magic=Buffer.from([0x28,0xb5,0x2f,0xfd]);while(i<b.length){if(b.compare(magic,i,i+4)!==0)break;let off=i+4;const fh=b[off++];let fhl=0;const type=fh&0x3;let len;if(type===0){fhl=fh>>3;off+=fhl;len=0;}else if(type===1){len=(b[off]|(b[off+1]<<8));off+=2;fhl=(fh>>3)+1;}else if(type===2){len=(b[off]|(b[off+1]<<8)|(b[off+2]<<16)|(b[off+3]<<24));off+=4;fhl=(fh>>3)+3;}else{len=b.readUInt32LE(off);off+=4;fhl=(fh>>3)+4;}let srcStart=off;let srcEnd=srcStart+len;if(fh&0x20){const dict=b[off+len];srcEnd+=dict+1;off+=dict+1;}out.push(srcStart);i=srcEnd;}return out;}
const fr=frames(buf);let text="";for(const [i,s] of fr.entries()){const e=(i+1<fr.length)?fr[i+1]:buf.length;try{text+=zstd.decompressSync(buf.subarray(s,e));}catch{}} 
const lines=text.split("\n");let n=0;for(const l of lines){if(l.includes("routing")||l.includes("Routing guidance")){n++;const obj=JSON.parse(l);const d=JSON.stringify(obj).slice(0,300);console.log("HIT:",d);}}
console.log("routing mentions:",n,"of",lines.length,"lines");