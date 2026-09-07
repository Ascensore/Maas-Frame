// Only called for a newly imported AI draft, never the editor's original timeline.
function values(collection) { return Array.isArray(collection) ? collection : Object.values(collection || {}); }
function rgb(hex) { return [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255); }
function set(tool,key,value) { if (tool.SetInput(key,value) === false) throw new Error('Fusion refused ' + key); }
function wire(tool,key,source) { if (tool.ConnectInput(key,source) === false) throw new Error('Fusion could not connect ' + key); }
module.exports = function editableGraphics(timeline, draft, availableFonts) {
  if (!draft.graphics?.length) return;
  // Fusion accepts an unavailable font but renders the entire composition black.
  // Check every title before replacing any of the reviewed graphic carriers.
  for (const graphic of draft.graphics) {
    const font=graphic.preset.font ?? 'DejaVu Sans';
    const styles=availableFonts?.[font];
    for (const style of ['Bold', ...(graphic.subtitle ? ['Regular'] : [])]) {
      if (!styles?.[style]) throw new Error('Install the '+font+' '+style+' font in Resolve before converting this draft.');
    }
  }
  const items=values(timeline.GetItemListInTrack('video',3));
  const offset=Number(timeline.GetStartFrame());
  const changes=[];
  try {
    for (const graphic of draft.graphics) {
      const item=items.find(i => i.GetStart()-offset === graphic.startFrame && i.GetEnd()-offset === graphic.endFrame);
      if (!item) throw new Error('Graphic clip timing differs from the reviewed draft');
      const before=values(item.GetFusionCompNameList());
      const comp=item.AddFusionComp();
      if (!comp) throw new Error('Resolve could not create an editable Fusion title');
      const added=values(item.GetFusionCompNameList()).filter(name => !before.includes(name));
      if (added.length !== 1) throw new Error('Could not identify the new Fusion composition');
      changes.push({item,name:added[0],previous:before[0]});
      const make=(kind) => { const t=comp.AddTool(kind); if (!t) throw new Error('Fusion tool unavailable: '+kind); if (kind==='Background' || kind==='TextPlus') { set(t,'UseFrameFormatSettings',0);set(t,'Width',1920);set(t,'Height',1080); } return t; };
      const transparent=make('Background'); set(transparent,'Width',1920);set(transparent,'Height',1080);set(transparent,'TopLeftAlpha',0);
      const preset=graphic.preset;
      const y=(preset.template ?? preset.id)==='lower-third' ? 820 : 400;
      const font=preset.font ?? 'DejaVu Sans';
      const addLayer=(background,foreground) => {const merge=make('Merge');wire(merge,'Background',background);wire(merge,'Foreground',foreground);return merge;};
      const rectangle=(color,x,top,width,height,alpha) => {
        const bg=make('Background');set(bg,'Width',1920);set(bg,'Height',1080);
        rgb(color).forEach((v,i)=>set(bg,['TopLeftRed','TopLeftGreen','TopLeftBlue'][i],v));set(bg,'TopLeftAlpha',alpha);
        const mask=make('RectangleMask');set(mask,'Center',{1:(x+width/2)/1920,2:1-(top+height/2)/1080});set(mask,'Width',width/1920);set(mask,'Height',height/1080);
        wire(bg,'EffectMask',mask);return bg;
      };
      let result=addLayer(transparent,(preset.template==='title-card') ? rectangle(preset.background,0,0,1920,1080,1) : rectangle(preset.background,96,y,1728,170,0.875));
      result=addLayer(result,rectangle(preset.accent,96,y,10,170,1));
      for (const [text,top,size,bold] of [[graphic.title,y+24,preset.titleSize??48,true],[graphic.subtitle,y+94,preset.subtitleSize??32,false]]) {
        if (!text) continue;
        const title=make('TextPlus');set(title,'StyledText',text);set(title,'Font',font);set(title,'Style',bold?'Bold':'Regular');
        set(title,'Size',Math.min(size,Math.floor(1600/Math.max(1,text.length)/0.7))/1920);
        set(title,'HorizontalLeftCenterRight',-1);set(title,'VerticalTopCenterBottom',-1);
        set(title,'Center',{1:128/1920,2:1-top/1080});
        rgb(preset.foreground).forEach((v,i)=>set(title,['Red1','Green1','Blue1'][i],v));
        result=addLayer(result,title);
      }
      const out=values(comp.GetToolList(false,'MediaOut'))[0] ?? make('MediaOut');
      wire(out,'Input',result);
      if (!item.LoadFusionCompByName(added[0])) throw new Error('Could not activate the Fusion title');
    }
  } catch(error) {
    for (const change of changes.reverse()) { change.item.DeleteFusionCompByName(change.name); if (change.previous) change.item.LoadFusionCompByName(change.previous); }
    throw error;
  }
};
