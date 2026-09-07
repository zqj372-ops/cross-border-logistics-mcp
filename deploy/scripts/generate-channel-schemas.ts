import { writeFileSync } from 'node:fs';
import { z } from 'zod';
import { channelHistorySchema, channelInput, channelSave, channelPublish, channelDisable, channelRollback, channelViewSchema, channelPreviewSchema, channelListSchema } from '../../services/access-gateway/portal/channel-contracts';
for(const [name,schema] of Object.entries({history:channelHistorySchema,input:channelInput,save:channelSave,publish:channelPublish,disable:channelDisable,rollback:channelRollback,view:channelViewSchema,preview:channelPreviewSchema,list:channelListSchema})){
 const filename=`portal-channels-${name}.schema.json`;
 writeFileSync(`schemas/access-gateway/${filename}`,JSON.stringify({...z.toJSONSchema(schema,{target:'draft-2020-12'}),$id:`https://freightclaw.local/schemas/${filename}`},null,2)+'\n');
}
