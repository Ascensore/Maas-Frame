// MOGRTs are explicitly chosen local files with the OpenFrame control contract.
function transaction(project, build, label) {
  let ok=false;
  project.lockedAccess(() => { ok=project.executeTransaction(compound => build(compound),label); });
  if (!ok) throw new Error('Premiere refused the title transaction');
}
async function controls(item) {
  const chain=await item.getComponentChain(); const result=new Map();
  for(let i=0;i<chain.getComponentCount();i++) {
    const component=chain.getComponentAtIndex(i);
    for(let j=0;j<component.getParamCount();j++) {
      const param=component.getParam(j);
      if (param.displayName.startsWith('OpenFrame ')) result.set(param.displayName.slice(10),param);
    }
  }
  return result;
}
module.exports = async function editableGraphics({ppro,project,sequence,draft,folder}) {
  if (!draft.graphics?.length) return;
  const editor=ppro.SequenceEditor.getEditor(sequence);
  const track=await sequence.getVideoTrack(2);
  const plates=await track.getTrackItems(1,false);
  const fps=draft.frameRate.num/draft.frameRate.den;
  const work=[];
  // Resolve every file and carrier before creating anything in the host.
  for(const graphic of draft.graphics) {
    const template=graphic.preset.template ?? (graphic.preset.id==='callout'?'callout':'lower-third');
    const file=await folder.getEntry(template+'.mogrt');
    if (!file?.nativePath) throw new Error('Missing local template: '+template+'.mogrt');
    let plate;
    for(const candidate of plates) {
      const start=await candidate.getStartTime();const end=await candidate.getEndTime();
      if(Math.round(start.seconds*fps)===graphic.startFrame && Math.round(end.seconds*fps)===graphic.endFrame) plate=candidate;
    }
    if(!plate) throw new Error('Graphic clip timing differs from the reviewed draft');
    work.push({graphic,file,plate});
  }
  const inserted=[];
  try {
    for(const {graphic,file,plate} of work) {
      if(String((await ppro.Project.getActiveProject())?.guid)!==String(project.guid)) throw new Error('The open project changed');
      const items=await editor.insertMogrtFromPath(file.nativePath,ppro.TickTime.createWithSeconds(graphic.startFrame/fps),3,2);
      inserted.push(...(items??[]));
      if(items?.length!==1) throw new Error('Use a video-only MOGRT without embedded audio');
      const item=items[0];const params=await controls(item);
      const p=graphic.preset;
      const color=hex=>new ppro.Color(...[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255),1);
      const settings={Title:graphic.title,Subtitle:graphic.subtitle,Accent:color(p.accent),Foreground:color(p.foreground),Background:color(p.background),Font:p.font??'DejaVu Sans',TitleSize:p.titleSize??48,SubtitleSize:p.subtitleSize??32};
      for(const key of Object.keys(settings)) if(!params.has(key)) throw new Error('MOGRT is missing control: OpenFrame '+key);
      transaction(project,compound=>{
        for(const [key,value] of Object.entries(settings)) {const param=params.get(key);compound.addAction(param.createSetValueAction(param.createKeyframe(value),true));}
        compound.addAction(item.createSetEndAction(ppro.TickTime.createWithSeconds(graphic.endFrame/fps)));
      },'Configure editable AI title');
      if(Math.round((await item.getEndTime()).seconds*fps)!==graphic.endFrame) throw new Error('MOGRT duration could not match the draft');
      // Keep every rendered plate enabled until the complete title set is ready.
      void plate;
    }
    transaction(project,compound=>{for(const w of work) compound.addAction(w.plate.createSetDisabledAction(true));},'Use editable AI titles');
  } catch(error) {
    if(inserted.length) transaction(project,compound=>{for(const item of inserted) compound.addAction(item.createSetDisabledAction(true));},'Hide incomplete AI titles');
    throw error;
  }
};
