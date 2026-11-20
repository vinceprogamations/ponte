# Chat e chamadas privados
ja
Status: aprovado pelo usuário em 2026-11-20, implementado e verificado localmente; exige instalação e pareamento dos dispositivos. Compartilhamento de tela e qualidade da call preservados nos testes locais.

## Intenção e requisitos

O Ponte antes enviava histórico e canais para qualquer par conectado, transmitia mensagens novas por broadcast e fornecia anexos sem autorização por canal. O usuário quer um chat e uma call visíveis e acessíveis apenas ao criador e a um convidado, além de uma call para as demais pessoas. Ele confirmou que todo o histórico atual deve ficar reservado aos dois.

A aplicação continua Electron, sem conta e sem servidor, usando a LAN/Radmin e WebRTC existentes. O convite usa um endereço de rede para localizar o criador. Endereços e nomes não são credenciais de acesso; dados específicos dos participantes não são publicados nesta documentação.

## Abordagens consideradas

1. Ocultar canais na interface: insuficiente, pois o protocolo continuaria entregando mensagens, anexos e sinalização a terceiros.
2. Autorizar apenas pelo IP ou nome: simples, mas não comprova a identidade do dispositivo e depende do endereço usado na conexão.
3. Autorizar dispositivos pareados e proteger o conteúdo privado antes de transmiti-lo: abordagem proposta pelo implementador, porque restringe tanto o acesso normal quanto pedidos diretos feitos por outros clientes.

O usuário aprovou a execução completa da abordagem 3 e delegou os detalhes técnicos.

## Comportamento para as pessoas

- O criador e o convidado terão um chat “Privado” e uma call “Call privada”.
- Haverá uma “Call geral” disponível para todos, incluindo os dois quando quiserem participar. O chat geral existente continuará disponível com um histórico público novo.
- Outros dispositivos não receberão a definição, as mensagens, os anexos, a presença na call ou a sinalização das salas privadas.
- A lista geral de pessoas online continua funcionando; estar online não revela a participação na call privada.
- Um dispositivo participa de uma call por vez, como hoje. Microfone, câmera, transmissão de tela, overlay e saída da call continuam associados à sala ativa.
- O pareamento acontece uma vez: o criador gera um convite e o compartilha com o convidado por um meio já privado; o convidado cola o convite nos ajustes. Não será enviado automaticamente por chat, email ou outro serviço.
- O convite só autoriza um segundo dispositivo. A interface permite conferir a identidade pareada e revogar o acesso, invalidando o convite e a sessão anteriores. Não haverá senha ou chave privada embutida no instalador ou no repositório.

## Identificação e autorização

- Cada instalação terá uma identidade criptográfica persistente. Chaves privadas e segredos ficam no processo principal e são protegidos pelo armazenamento seguro do Electron quando disponível; indisponibilidade desse armazenamento deve impedir a ativação privada com uma mensagem clara.
- O criador e o segundo dispositivo são os únicos membros autorizados. O convite contém um segredo aleatório forte e a identidade pública do criador; a entrada exige prova de posse do segredo e vincula a identidade do segundo dispositivo.
- O perfil local existente será configurado como criador na ativação, sem conceder privilégios com base no nome ou no IP. Só o criador pode aprovar um novo segundo dispositivo. Uma instalação nova não herda a identidade ou o papel do criador.
- O aceite do segundo dispositivo precisa ser confirmado no dispositivo criador antes de liberar histórico ou mídia. A tela identifica nome, endereço observado e impressão digital. Isso impede que um convite vazado consuma silenciosamente a segunda vaga.
- O IP fornecido serve para descoberta e apresentação do candidato, sem substituir a autorização criptográfica.
- A confiança persiste entre reinicializações. Reinstalação que perca a identidade exige novo pareamento; alteração de nome ou IP não concede acesso.
- Pedidos de entrada repetidos, identidade declarada sem prova, mensagens fora de sessão e versões antigas do protocolo não recebem dados privados.

## Transporte e limites de segurança

- O tráfego privado de controle e chat usará uma conexão TLS 1.3 separada, com certificados por dispositivo e verificação explícita das identidades pareadas. Não será criado um protocolo próprio de criptografia. A geração dos certificados deverá usar uma biblioteca mantida, sem depender de um OpenSSL instalado pelo usuário.
- O convite inclui a impressão digital do certificado do criador, que o convidado verifica antes de apresentar qualquer segredo. A conexão inicial aceita apenas o fluxo de entrada, com segredo de uso único, e não ganha permissão para dados do app até a confirmação do criador. As conexões posteriores exigem os certificados já autorizados.
- A autorização pertence ao socket TLS e à identidade criptográfica validada, nunca ao UUID declarado no protocolo LAN. Um terceiro que assuma o mesmo UUID não pode substituir uma conexão privada autenticada. Alteração do certificado, reconexão ou retomada de sessão exige nova validação da autorização vigente.
- A validação explícita da impressão digital ocorre antes de ler ou enviar dados do app, inclusive ao usar certificados próprios sem uma autoridade certificadora pública. Desativar a validação da cadeia de certificados não desativa a verificação da identidade pareada. Rotação ou perda do certificado exige um novo pareamento aprovado pelo criador.
- Mensagens privadas, edições, exclusões, reações, respostas, digitação, nomes de canais, estado da call, SDP e ICE só atravessam essa sessão.
- Anexos privados exigem autorização no pedido e em toda a transferência; não podem ser obtidos pelo protocolo público `file-get`, mesmo conhecendo o UUID. O envio em fila deve revalidar a autorização antes de começar e durante a transferência.
- Mensagens, canais e arquivos têm classificação persistente e espaços de identificação separados. Dados públicos não alteram objetos privados por colisão de ID ou por alegar uma versão maior. Referenciar um anexo privado em mensagem pública não o torna público. Arquivos legados sem mensagem associada e downloads incompletos também são privados por padrão.
- A sinalização WebRTC privada só é aceita de um membro autenticado na mesma call. Áudio, câmera e tela usam o transporte criptografado do WebRTC existente.
- Cada entrada em uma call recebe um identificador de sessão; SDP/ICE atrasados de uma call anterior são descartados mesmo quando enviados por um membro autorizado.
- O processo principal valida autorização também nas operações IPC e na seleção de sala, sem confiar apenas nos filtros da interface.
- Revogar ou perder a sessão fecha a mídia privada e impede novos envios. A revogação encerra sockets, transferências em fila e recebimentos incompletos, invalida convites e exige nova autorização mesmo em retomadas TLS. Não haverá reconexão automática para a call geral ao perder acesso.
- O modelo protege contra um terceiro cliente da rede que tente pedir histórico, anexos ou entrar na call. Não protege contra um participante autorizado que copie conteúdo, nem contra comprometimento do computador autorizado.

## Histórico e atualização de versões antigas

- A migração é executada antes de iniciar a rede, com backup local e marcador de versão, sem apagar o histórico original silenciosamente.
- Todo o histórico legado permanece em um arquivo separado que nunca é sincronizado pelo protocolo público novo. No perfil criador, é incorporado ao chat privado preservando IDs, autores, datas, arquivos, respostas, reações e estados de edição/exclusão.
- As mensagens de todos os canais de texto antigos são reunidas no chat “Privado”, mantendo o nome do canal de origem como metadado de histórico. As definições originais ficam no arquivo de migração; salas de voz antigas não são reabertas nem sincronizadas. A interface passa a oferecer “Call privada” e “Call geral”.
- O arquivo de migração preserva todas as mensagens existentes no disco, independentemente do limite atual de 2.000 mensagens do `ChatStore`. Esse arquivo não pode ser truncado por `merge()` ou `saveSoon()`. Para versões iguais, mantém-se a cópia local e registra-se o conflito no arquivo de migração; versões maiores só atualizam a cópia do mesmo espaço privado autenticado.
- O convidado recebe o histórico somente depois de pareado e aprovado; seu histórico legado também pode ser incorporado à mesma conversa privada, com deduplicação por ID e versão.
- Em outros perfis atualizados, o histórico legado fica em quarentena local, sem reenvio e sem importação automática para a conversa pública. A atualização não consegue impedir o acesso a cópias que esses usuários já tenham salvo em disco.
- O chat público novo tem um identificador e uma versão de protocolo novos. Pacotes legados de histórico/canais não podem repovoá-lo nem reclassificar mensagens privadas como públicas.
- Clientes antigos continuam sendo tratados como não autorizados para conteúdo privado. Para deixar de retransmitir cópias antigas entre si, as instalações antigas também precisarão atualizar. Não é possível recolher o que já foi entregue.
- Testes e modo de demonstração usam identidades e dados isolados; não migram nem expõem o perfil real.

## Partes afetadas

- `src/main/lan.js`: identificação de sessão, roteamento e publicação de estado por destinatário.
- Novo módulo de identidade, pareamento e transporte TLS privado no processo principal, testável com Node puro.
- `src/main/chat.js`: classificação privada/pública, histórico legado, migração e sincronização autorizada.
- `src/main/main.js`: aplicação das permissões em conexão, mensagens, IPC e sinalização.
- `src/main/media.js`: autorização e transferência privada de anexos.
- `src/main/preload.js`: operações de pareamento e estado privado sem expor segredos internos.
- Interface e ajustes: chat/calls separados, indicação de privacidade e pareamento.
- README e testes: novo comportamento, limites de migração e configuração entre os dois dispositivos.

## Critérios de aceitação e verificação

1. Três dispositivos isolados: criador, convidado e terceiro. Apenas os dois autorizados recebem qualquer dado privado; o terceiro pode participar da call geral.
2. Tentativas diretas do terceiro de pedir histórico, editar/reagir, baixar arquivo por UUID ou enviar sinalização privada falham sem revelar conteúdo.
3. Copiar nome, IP declarado, UUID ou chave pública sem a chave privada não concede acesso. Convite sem aprovação, convite revogado, repetição de pacotes e novo dispositivo também não concedem acesso.
4. Anexos grandes mantêm o comportamento em blocos e não passam pelo caminho público; revogação interrompe envios e WebRTC privados.
5. A migração preserva o histórico e os arquivos dos autorizados, é idempotente, mantém backup e não publica histórico legado durante a inicialização, reconexão ou contato com clientes antigos.
6. Reiniciar os dois perfis preserva o pareamento. Trocar de call ou sair fecha conexões da sala anterior sem vazar áudio/tela.
7. A suíte atual de LAN continua passando; testes de integração cobrem o roteamento real, não apenas funções de filtro.
8. Pacotes públicos de `auth` e `state` omitem todos os atributos da call privada, incluindo sala, voz, câmera, compartilhamento e identificadores de mídia. Colisões de IDs, versões maiores em mensagens públicas e arquivos legados sem referência não contornam a classificação privada.

## Entrega e pendências operacionais

A primeira entrega altera e testa o código local e gera o instalador 2.2.0. Publicação ocorre somente mediante autorização do usuário. O app não envia convites para terceiros nem ativa pareamento em outro computador automaticamente. A instalação da nova versão e o pareamento nos dois dispositivos são necessários para usar a proteção.
