## Conversas privadas, sem perder a qualidade da call

A Ponte 2.2.0 separa a conversa de duas pessoas do espaço geral da rede.

- **Chat e call privados:** apenas dois dispositivos pareados e autorizados recebem mensagens, arquivos e presença na call privada.
- **Histórico anterior reservado:** as conversas das versões antigas ficam separadas do chat geral novo, com um arquivo local preservado antes de iniciar a rede.
- **Conexão privada criptografada:** identidade por dispositivo, TLS 1.3 e confirmação do criador. Copiar nome ou identificador não concede acesso.
- **Call geral separada:** disponível para o restante do grupo e para os dois membros privados quando quiserem participar.
- **Tela e áudio preservados:** mesmas configurações de captura, resolução, FPS, bitrate, câmera e processamento de áudio. Os testes locais validaram captura em 1920×1080 a 60 fps configurados, limite de 7,2 Mbps e recebimento de áudio e vídeo.
- **Reconexão mais resistente:** anexos privados interrompidos voltam a ser pedidos, e históricos grandes são divididos pelo tamanho em bytes para não derrubar a conexão.

## Ative o espaço privado uma vez

1. Atualize os dois computadores e abra **Ajustes → Conversa privada**.
2. No computador criador, clique em **Criar convite privado** e envie o convite ao seu amigo por uma conversa que já seja privada. Não use o chat geral. O convite vale por 15 minutos.
3. No outro computador, cole o convite e clique em **Aceitar convite**.
4. No criador, confira nome, endereço e identidade com seu amigo e clique em **Autorizar este dispositivo**.

O chat **Privado 🔒** e a **Call privada 🔒** ficam disponíveis apenas aos dois dispositivos. Para substituir o convidado, use **Revogar acesso** e faça um novo pareamento.

**Atualize todas as instalações.** Esta versão não retransmite o histórico antigo pelo espaço público, mas versões antigas continuam com o comportamento anterior entre si. Cópias que outras pessoas já receberam não podem ser recolhidas.

## Como instalar

1. Baixe o **Ponte-Instalar.exe** logo abaixo.
2. Dê dois cliques nele.
   - Se aparecer "O Windows protegeu o computador", clique em **Mais informações → Executar assim mesmo**. O aviso aparece porque o app não é assinado.
   - Aceite o pedido de administrador. O instalador libera a Ponte no firewall, inclusive na rede do Radmin VPN.
3. A Ponte abre sozinha no final. Quem estiver na mesma rede aparece online automaticamente.

## Já tem a Ponte?

Não precisa baixar nada: a partir da versão 1.4.0, a Ponte encontra esta versão sozinha quando abre, instala e reabre.
Os arquivos `latest.yml` e `.blockmap` abaixo são usados por essa atualização automática.
